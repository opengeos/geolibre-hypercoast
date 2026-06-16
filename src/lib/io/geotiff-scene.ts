/**
 * Reader for the GeoTIFF-gridded hyperspectral sensors: DESIS, EnMAP, Wyvern,
 * and classic AVIRIS. These ship reflectance as a multi-band GeoTIFF already
 * orthorectified in a projected CRS, so each band is a plain raster read and the
 * only georeferencing work is reprojecting the grid corners (handled by
 * {@link makeProjectedGridReader}).
 *
 * Band center wavelengths are usually NOT in the raster; they are resolved by
 * {@link resolveWavelengths} (in-file tags → remote CSV → bundled table). The
 * sensor is inferred from the file name and band count, mirroring how HyperCoast's
 * `read_desis` / `read_enmap` / `read_wyvern` pick their wavelength source and
 * reflectance scaling.
 */

import { fromArrayBuffer, type GeoTIFFImage } from "geotiff";
import type { SceneReader } from "./SceneReader";
import { makeProjectedGridReader, type ProjectedGridSource } from "./grid-reader";
import type { GeoTransform } from "../render/orthorectify";
import { resolveWavelengths } from "./wavelength-tables";

/** Parse per-sample wavelengths from a GDAL_METADATA XML blob, if present. */
function wavelengthsFromGdalMetadata(xml: string | undefined, bandCount: number): number[] | null {
  if (!xml) return null;
  const out = new Array<number>(bandCount).fill(NaN);
  let found = 0;
  // <Item name="wavelength" sample="0" role="...">503.0</Item>, and Wyvern-style
  // long_name="band_503" descriptions.
  const re = /<Item\b([^>]*)>([^<]*)<\/Item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2].trim();
    const sampleM = attrs.match(/sample="(\d+)"/);
    const nameM = attrs.match(/name="([^"]+)"/);
    if (!sampleM || !nameM) continue;
    const sample = parseInt(sampleM[1], 10);
    const key = nameM[1].toLowerCase();
    if (sample < 0 || sample >= bandCount) continue;
    if (key === "wavelength" || key === "wavelengths") {
      const v = parseFloat(body);
      if (Number.isFinite(v)) {
        out[sample] = v;
        found++;
      }
    } else if (key === "long_name" && Number.isNaN(out[sample])) {
      const v = parseFloat(body.split("_")[1] ?? "");
      if (Number.isFinite(v)) {
        out[sample] = v;
        found++;
      }
    }
  }
  return found === bandCount ? out : null;
}

/** Infer the sensor id from the file name and band count. */
function inferSensor(name: string, bandCount: number): string {
  const n = name.toLowerCase();
  if (n.includes("desis")) return "DESIS";
  if (n.includes("enmap")) return "EnMAP";
  if (n.includes("wyvern") || n.includes("dragonette")) return "Wyvern";
  if (n.includes("aviris") || n.startsWith("ang")) return "AVIRIS";
  if (bandCount === 235) return "DESIS";
  if (bandCount === 23 || bandCount === 31) return "Wyvern";
  if (bandCount === 224) return "EnMAP";
  return "Hyperspectral";
}

/** Per-sensor reflectance scale factor given the raster dtype (integer → ÷10000). */
function scaleFactorFor(sensor: string, isInteger: boolean): number {
  if (!isInteger) return 1; // already float reflectance
  if (sensor === "DESIS" || sensor === "EnMAP") return 1 / 10000;
  return 1;
}

/** EnMAP uses 0 as its fill value; others fall back to the GeoTIFF's NoData tag. */
function fillValueFor(sensor: string, noData: number | null): number | null {
  if (sensor === "EnMAP" && noData == null) return 0;
  return noData;
}

/**
 * Open a GeoTIFF hyperspectral scene (DESIS / EnMAP / Wyvern / AVIRIS).
 *
 * @param bytes - The complete `.tif` file contents.
 * @param name - Human-readable scene name (used to infer the sensor).
 * @param fetchArrayBuffer - Host hook for fetching the remote wavelength CSV.
 * @param sensorHint - Force a sensor id instead of inferring it (UI override).
 * @returns A {@link SceneReader} over the scene.
 */
export async function openGeoTiffScene(
  bytes: ArrayBuffer,
  name: string,
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>,
  sensorHint?: string,
): Promise<SceneReader> {
  const tiff = await fromArrayBuffer(bytes);
  const image: GeoTIFFImage = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  const bandCount = image.getSamplesPerPixel();
  if (bandCount < 3) {
    throw new Error(`GeoTIFF has only ${bandCount} band(s); not a hyperspectral cube.`);
  }

  const sensor = sensorHint && sensorHint !== "auto" ? sensorHint : inferSensor(name, bandCount);

  const origin = image.getOrigin();
  const res = image.getResolution();
  const gt: GeoTransform = [origin[0], res[0], 0, origin[1], 0, res[1]];

  const geoKeys = (image.getGeoKeys() ?? {}) as Record<string, number>;
  const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || 4326;

  const dir = image.getFileDirectory() as { GDAL_METADATA?: string };
  const inFile = wavelengthsFromGdalMetadata(dir.GDAL_METADATA, bandCount);
  const wavelengths = await resolveWavelengths({ sensor, bandCount, inFile, fetchArrayBuffer });

  const noData = image.getGDALNoData();
  const fill = fillValueFor(sensor, noData);

  // Determine dtype once (drives reflectance scaling) from a 1-pixel probe.
  const probe = (await image.readRasters({ window: [0, 0, 1, 1], samples: [0] })) as unknown as Array<ArrayLike<number>>;
  const isInteger = !(probe[0] instanceof Float32Array || probe[0] instanceof Float64Array);
  const scale = scaleFactorFor(sensor, isInteger);

  const apply = (v: number): number => (fill != null && v === fill ? NaN : v * scale);

  const source: ProjectedGridSource = {
    sensor,
    width,
    height,
    bandCount,
    wavelengths,
    gt,
    epsg,
    async readOrthoBand(band: number): Promise<Float32Array> {
      const rasters = (await image.readRasters({ samples: [band] })) as unknown as Array<ArrayLike<number>>;
      const src = rasters[0];
      const out = new Float32Array(width * height);
      for (let i = 0; i < out.length; i++) out[i] = apply(src[i] as number);
      return out;
    },
    async readSpectrumColRow(col: number, row: number): Promise<Float32Array | null> {
      const rasters = (await image.readRasters({
        window: [col, row, col + 1, row + 1],
      })) as unknown as Array<ArrayLike<number>>;
      const out = new Float32Array(bandCount);
      for (let b = 0; b < bandCount; b++) out[b] = apply(rasters[b][0] as number);
      return out;
    },
    close(): void {
      // geotiff holds no WASM/MEMFS handle to release; the ArrayBuffer is GC'd.
    },
  };

  return makeProjectedGridReader(name, source);
}
