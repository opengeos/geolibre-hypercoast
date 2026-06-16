/**
 * Reader for NASA EMIT L2A reflectance scenes (netCDF4 / HDF5).
 *
 * EMIT stores reflectance in sensor (swath) geometry as `reflectance` with dims
 * (downtrack, crosstrack, bands). The `location` group holds the Geometry Lookup
 * Table (`glt_x`, `glt_y`) sized to the orthorectified grid, and a root
 * `geotransform` attribute places that grid in EPSG:4326. Band wavelengths and
 * the usable-band flags live in `sensor_band_parameters`.
 *
 * Band reads pull one swath band via an HDF5 hyperslab, then orthorectify it
 * with {@link applyGlt}. Spectrum reads invert the geotransform to find the ortho
 * cell, follow the GLT to the swath pixel, and slice all bands at that pixel.
 *
 * Structure and orthorectification adapted from NASA's EMIT-Data-Resources
 * (Apache-2.0) via HyperCoast's `emit_xarray`.
 */

import { closeH5, h5NumberArray as toNumberArray, type Dataset, type OpenedH5 } from "./h5";
import type { SceneMetadata, SceneReader } from "./SceneReader";
import {
  applyGlt,
  geotransformToBounds,
  lngLatToColRow,
  EMIT_FILL_VALUE,
  GLT_NODATA,
  type GeoTransform,
} from "../render/orthorectify";

/**
 * Detect whether an open HDF5 file is an EMIT L2A reflectance scene.
 *
 * @param f - An open h5wasm file.
 * @returns True if the EMIT-defining datasets/attributes are present.
 */
export function isEmitScene(f: OpenedH5["file"]): boolean {
  return Boolean(f.attrs["geotransform"]) && f.get("location/glt_x") != null;
}

/**
 * Open an EMIT L2A reflectance scene and return a reader over it.
 *
 * @param opened - An already-opened EMIT `.nc` (HDF5) handle; the reader takes
 *   ownership and closes it via {@link SceneReader.close} or on failure.
 * @param name - A human-readable scene name (typically the file name).
 * @returns A {@link SceneReader} backed by the opened file.
 * @throws If the file is missing the datasets/attributes an EMIT L2A scene must have.
 */
export async function openEmitScene(
  opened: OpenedH5,
  name: string,
): Promise<SceneReader> {
  const f = opened.file;

  try {
    const gtAttr = f.attrs["geotransform"];
    if (!gtAttr) throw new Error("Missing 'geotransform' attribute; not an EMIT L2A scene.");
    const gt = toNumberArray(gtAttr.value) as GeoTransform;

    const refl = f.get("reflectance") as Dataset | null;
    if (!refl || !refl.shape || refl.shape.length !== 3) {
      throw new Error("Missing or malformed 'reflectance' dataset.");
    }
    const [swathH, swathW, bandCount] = refl.shape;

    const gltxDs = f.get("location/glt_x") as Dataset | null;
    const gltyDs = f.get("location/glt_y") as Dataset | null;
    if (!gltxDs?.shape || !gltyDs?.shape) {
      throw new Error("Missing GLT datasets ('location/glt_x' / 'location/glt_y').");
    }
    const [gltH, gltW] = gltxDs.shape;
    const gltX = gltxDs.value as Int32Array;
    const gltY = gltyDs.value as Int32Array;

    const wlDs = f.get("sensor_band_parameters/wavelengths") as Dataset | null;
    if (!wlDs) throw new Error("Missing 'sensor_band_parameters/wavelengths'.");
    const wavelengths = toNumberArray(wlDs.value);

    const goodDs = f.get("sensor_band_parameters/good_wavelengths") as Dataset | null;
    const goodArr = goodDs ? (goodDs.value as Uint8Array) : null;
    const goodWavelengths = wavelengths.map((_, i) => (goodArr ? goodArr[i] !== 0 : true));

    const bounds = geotransformToBounds(gt, gltW, gltH);

    const metadata: SceneMetadata = {
      sensor: "EMIT",
      name,
      width: gltW,
      height: gltH,
      bandCount,
      wavelengths,
      goodWavelengths,
      bounds,
    };

    let closed = false;

    return {
      metadata,

      async readOrthoBand(bandIndex: number): Promise<Float32Array> {
        if (closed) throw new Error("Scene has been closed.");
        const band = Math.max(0, Math.min(bandCount - 1, bandIndex));
        const slab = refl.slice([
          [0, swathH],
          [0, swathW],
          [band, band + 1],
        ]) as Float32Array;
        return applyGlt(slab, swathW, swathH, gltX, gltY, gltW, gltH, EMIT_FILL_VALUE);
      },

      async readSpectrumAt(lng: number, lat: number): Promise<Float32Array | null> {
        if (closed) throw new Error("Scene has been closed.");
        const { col, row } = lngLatToColRow(gt, lng, lat);
        if (col < 0 || col >= gltW || row < 0 || row >= gltH) return null;

        const gi = row * gltW + col;
        const gx = gltX[gi];
        const gy = gltY[gi];
        if (gx === GLT_NODATA || gy === GLT_NODATA) return null;

        const sx = gx - 1; // crosstrack (column)
        const sy = gy - 1; // downtrack (row)
        if (sx < 0 || sx >= swathW || sy < 0 || sy >= swathH) return null;

        const spec = refl.slice([
          [sy, sy + 1],
          [sx, sx + 1],
          [0, bandCount],
        ]) as Float32Array;

        const out = new Float32Array(bandCount);
        for (let i = 0; i < bandCount; i++) {
          const v = spec[i];
          out[i] = v === EMIT_FILL_VALUE || !goodWavelengths[i] ? NaN : v;
        }
        return out;
      },

      close(): void {
        if (closed) return;
        closed = true;
        closeH5(opened);
      },
    };
  } catch (err) {
    // Free the WASM memory if setup failed after the file was opened.
    closeH5(opened);
    throw err;
  }
}
