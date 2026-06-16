/**
 * Readers for swath-geometry sensors that georeference with 2-D per-pixel
 * latitude/longitude arrays instead of a GLT or affine: NASA PACE OCI (`.nc`) and
 * Planet Tanager (`.h5`, HDFEOS SWATHS layout). Both are resampled onto a regular
 * EPSG:4326 grid by {@link buildSwathGrid} (nearest forward scatter), then read
 * band-by-band like any other scene.
 *
 * The two sensors differ only in cube layout and where lat/lon/wavelengths live;
 * {@link makeSwathReader} factors out the shared resampling, band scatter, and
 * spectral lookup. Mirrors HyperCoast's `read_pace` and `read_tanager`.
 */

import {
  closeH5,
  h5Exists,
  h5NumberArray,
  h5AttrNumber,
  type Dataset,
  type Group,
  type OpenedH5,
} from "./h5";
import type { SceneMetadata, SceneReader } from "./SceneReader";
import {
  buildSwathGrid,
  geotransformToBounds,
  swathGridColRow,
  type SwathGrid,
} from "../render/orthorectify";

/** Coerce an h5wasm typed array (any dtype) to a Float32Array. */
function toFloat32(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (ArrayBuffer.isView(value)) return Float32Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return Float32Array.from(value as number[]);
  throw new Error("Expected a numeric hyperslab result.");
}

/** A swath scene: 2-D lat/lon plus closures to read a band / a pixel's spectrum. */
export interface SwathSource {
  sensor: string;
  swathW: number;
  swathH: number;
  bandCount: number;
  wavelengths: number[];
  goodWavelengths?: boolean[];
  /** Per-pixel longitudes, row-major [downtrack, crosstrack]. */
  lon: ArrayLike<number>;
  /** Per-pixel latitudes, same layout. */
  lat: ArrayLike<number>;
  /** Read one swath band as a Float32Array (length swathW*swathH), NaN for fill. */
  readSwathBand(band: number): Promise<Float32Array>;
  /** Read the full spectrum at swath pixel (sx, sy), NaN for fill/unusable bands. */
  readSwathSpectrum(sx: number, sy: number): Promise<Float32Array | null>;
  close(): void;
}

/**
 * Wrap a {@link SwathSource} as a {@link SceneReader}: build the resampling grid
 * once, scatter each requested band onto it, and resolve clicked points to the
 * nearest swath pixel.
 *
 * @param name - Human-readable scene name.
 * @param src - The swath source.
 * @returns A {@link SceneReader} the UI drives like any other scene.
 */
export function makeSwathReader(name: string, src: SwathSource): SceneReader {
  const grid: SwathGrid = buildSwathGrid(src.lon, src.lat, src.swathW, src.swathH);
  const { width, height, srcIndex } = grid;

  const metadata: SceneMetadata = {
    sensor: src.sensor,
    name,
    width,
    height,
    bandCount: src.bandCount,
    wavelengths: src.wavelengths,
    goodWavelengths: src.goodWavelengths ?? src.wavelengths.map(() => true),
    bounds: geotransformToBounds(grid.gt, width, height),
    crs: "EPSG:4326",
  };

  let closed = false;

  return {
    metadata,

    async readOrthoBand(bandIndex: number): Promise<Float32Array> {
      if (closed) throw new Error("Scene has been closed.");
      const band = Math.max(0, Math.min(src.bandCount - 1, bandIndex));
      const swath = await src.readSwathBand(band);
      const out = new Float32Array(width * height);
      out.fill(NaN);
      for (let i = 0; i < srcIndex.length; i++) {
        const s = srcIndex[i];
        if (s >= 0) out[i] = swath[s];
      }
      return out;
    },

    async readSpectrumAt(lng: number, lat: number): Promise<Float32Array | null> {
      if (closed) throw new Error("Scene has been closed.");
      const { col, row } = swathGridColRow(grid, lng, lat);
      if (col < 0 || col >= width || row < 0 || row >= height) return null;
      const s = srcIndex[row * width + col];
      if (s < 0) return null;
      const sx = s % src.swathW;
      const sy = Math.floor(s / src.swathW);
      return src.readSwathSpectrum(sx, sy);
    },

    close(): void {
      if (closed) return;
      closed = true;
      src.close();
    },
  };
}

// ---------------------------------------------------------------------------
// PACE OCI (.nc)
// ---------------------------------------------------------------------------

/** Detect a PACE OCI L2 file by its navigation + geophysical groups. */
export function isPaceScene(f: OpenedH5["file"]): boolean {
  return h5Exists(f, "navigation_data/longitude") && h5Exists(f, "geophysical_data");
}

/** Find the 3-D hyperspectral cube in PACE's geophysical_data group (prefer Rrs). */
function findPaceCube(f: OpenedH5["file"]): { name: string; ds: Dataset } | null {
  const group = f.get("geophysical_data") as Group | null;
  if (!group) return null;
  const keys = group.keys();
  const ordered = ["Rrs", ...keys.filter((k) => k !== "Rrs")];
  for (const key of ordered) {
    const ds = f.get(`geophysical_data/${key}`) as Dataset | null;
    if (ds?.shape && ds.shape.length === 3) return { name: key, ds };
  }
  return null;
}

/**
 * Open a PACE OCI L2 hyperspectral scene (e.g. an OC_AOP `Rrs` product).
 *
 * @param opened - An open PACE `.nc` handle; the reader takes ownership.
 * @param name - Human-readable scene name.
 * @returns A {@link SceneReader} over the scene.
 */
export async function openPaceScene(opened: OpenedH5, name: string): Promise<SceneReader> {
  const f = opened.file;
  try {
    const cube = findPaceCube(f);
    if (!cube?.ds.shape) throw new Error("No 3-D reflectance cube in PACE 'geophysical_data'.");
    const [swathH, swathW, bandCount] = cube.ds.shape;

    const lonDs = f.get("navigation_data/longitude") as Dataset | null;
    const latDs = f.get("navigation_data/latitude") as Dataset | null;
    if (!lonDs || !latDs) throw new Error("Missing PACE navigation_data lat/lon.");
    const lon = toFloat32(lonDs.value);
    const lat = toFloat32(latDs.value);

    const wlDs = f.get("sensor_band_parameters/wavelength_3d") as Dataset | null;
    const wavelengths = wlDs
      ? h5NumberArray(wlDs.value)
      : Array.from({ length: bandCount }, (_, i) => i + 1);

    const fill = h5AttrNumber(cube.ds.attrs, "_FillValue") ?? -32767;
    const scale = h5AttrNumber(cube.ds.attrs, "scale_factor") ?? 1;
    const offset = h5AttrNumber(cube.ds.attrs, "add_offset") ?? 0;
    const decode = (v: number): number => (v === fill ? NaN : v * scale + offset);

    const source: SwathSource = {
      sensor: "PACE",
      swathW,
      swathH,
      bandCount,
      wavelengths,
      lon,
      lat,
      async readSwathBand(band: number): Promise<Float32Array> {
        const slab = toFloat32(
          cube.ds.slice([[0, swathH], [0, swathW], [band, band + 1]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = decode(slab[i]);
        return slab;
      },
      async readSwathSpectrum(sx: number, sy: number): Promise<Float32Array | null> {
        const slab = toFloat32(
          cube.ds.slice([[sy, sy + 1], [sx, sx + 1], [0, bandCount]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = decode(slab[i]);
        return slab;
      },
      close: () => closeH5(opened),
    };
    return makeSwathReader(name, source);
  } catch (err) {
    closeH5(opened);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tanager (.h5, HDFEOS SWATHS layout)
// ---------------------------------------------------------------------------

const TANAGER_SWATHS = "HDFEOS/SWATHS/HYP";

/** Detect a Tanager HDFEOS SWATHS file. */
export function isTanagerScene(f: OpenedH5["file"]): boolean {
  return h5Exists(f, `${TANAGER_SWATHS}/Geolocation Fields/Latitude`);
}

/** Find the 3-D radiance/reflectance cube under a Tanager Data Fields group. */
function findTanagerCube(f: OpenedH5["file"], dfPath: string): { name: string; ds: Dataset } | null {
  const group = f.get(dfPath) as Group | null;
  if (!group) return null;
  const preferred = ["surface_reflectance", "toa_radiance"];
  const keys = group.keys();
  const ordered = [...preferred.filter((k) => keys.includes(k)), ...keys];
  for (const key of ordered) {
    const ds = f.get(`${dfPath}/${key}`) as Dataset | null;
    // Tanager cubes are (band, y, x) with band in the plausible hyperspectral range.
    if (ds?.shape && ds.shape.length === 3 && ds.shape[0] >= 60 && ds.shape[0] <= 600) {
      return { name: key, ds };
    }
  }
  return null;
}

/**
 * Open a Tanager hyperspectral scene (HDFEOS SWATHS layout).
 *
 * @param opened - An open Tanager `.h5` handle; the reader takes ownership.
 * @param name - Human-readable scene name.
 * @returns A {@link SceneReader} over the scene.
 */
export async function openTanagerScene(opened: OpenedH5, name: string): Promise<SceneReader> {
  const f = opened.file;
  try {
    const dfPath = `${TANAGER_SWATHS}/Data Fields`;
    const cube = findTanagerCube(f, dfPath);
    if (!cube?.ds.shape) throw new Error("No Tanager radiance/reflectance cube found.");
    const [bandCount, swathH, swathW] = cube.ds.shape;

    const gf = `${TANAGER_SWATHS}/Geolocation Fields`;
    const latDs = f.get(`${gf}/Latitude`) as Dataset | null;
    const lonDs = f.get(`${gf}/Longitude`) as Dataset | null;
    if (!latDs || !lonDs) throw new Error("Missing Tanager Geolocation Fields.");
    const lat = toFloat32(latDs.value);
    const lon = toFloat32(lonDs.value);

    // Wavelengths live either as a cube attribute or a sibling dataset (µm→nm
    // when values look like micrometres). Tanager stores them as the cube's
    // `wavelengths` attribute; other layouts use a `Wavelength(s)` dataset.
    const wlKeys = ["wavelengths", "Wavelengths", "wavelength", "Wavelength", "Wavelength(s)"];
    let wavelengths: number[] | null = null;
    for (const key of wlKeys) {
      const attr = cube.ds.attrs[key];
      if (attr) {
        wavelengths = h5NumberArray(attr.value);
        break;
      }
    }
    if (!wavelengths) {
      for (const key of wlKeys) {
        const ds = f.get(`${dfPath}/${key}`) as Dataset | null;
        if (ds) {
          wavelengths = h5NumberArray(ds.value);
          break;
        }
      }
    }
    if (!wavelengths || wavelengths.length !== bandCount) {
      wavelengths = Array.from({ length: bandCount }, (_, i) => i + 1);
    }
    const maxWl = Math.max(...wavelengths);
    if (maxWl > 0 && maxWl < 10) wavelengths = wavelengths.map((w) => w * 1000); // µm → nm
    wavelengths = wavelengths.map((w) => Math.round(w * 100) / 100);

    const fill =
      h5AttrNumber(cube.ds.attrs, "_FillValue") ??
      h5AttrNumber(cube.ds.attrs, "FillValue") ??
      h5AttrNumber(cube.ds.attrs, "missing_value");
    const scale = h5AttrNumber(cube.ds.attrs, "scale_factor") ?? 1;
    const offset = h5AttrNumber(cube.ds.attrs, "add_offset") ?? 0;
    const decode = (v: number): number =>
      fill != null && v === fill ? NaN : v * scale + offset;

    const source: SwathSource = {
      sensor: "Tanager",
      swathW,
      swathH,
      bandCount,
      wavelengths,
      lon,
      lat,
      async readSwathBand(band: number): Promise<Float32Array> {
        // (band, y, x) → slab (1, swathH, swathW), row-major sy*swathW + sx.
        const slab = toFloat32(
          cube.ds.slice([[band, band + 1], [0, swathH], [0, swathW]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = decode(slab[i]);
        return slab;
      },
      async readSwathSpectrum(sx: number, sy: number): Promise<Float32Array | null> {
        const slab = toFloat32(
          cube.ds.slice([[0, bandCount], [sy, sy + 1], [sx, sx + 1]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = decode(slab[i]);
        return slab;
      },
      close: () => closeH5(opened),
    };
    return makeSwathReader(name, source);
  } catch (err) {
    closeH5(opened);
    throw err;
  }
}
