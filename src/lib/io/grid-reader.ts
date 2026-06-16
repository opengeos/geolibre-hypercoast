/**
 * Shared {@link SceneReader} scaffolding for sensors whose data is already
 * gridded in a projected (north-up) CRS — the HDF5-gridded sensors (NEON,
 * PRISMA, AVIRIS-3/5) and the GeoTIFF sensors (DESIS, EnMAP, Wyvern, classic
 * AVIRIS). Unlike EMIT, these need no GLT: a band is read directly, row-major
 * with row 0 north.
 *
 * The only georeferencing work is reprojection. The grid lives in projected
 * metres, but the map overlay wants an EPSG:4326 quad, so {@link makeProjectedGridReader}
 * derives the geographic bounds by reprojecting the grid corners. Spectrum lookups
 * stay exact: a clicked lng/lat is projected back to metres and inverted through
 * the affine, with no reliance on the quad approximation.
 */

import type { SceneMetadata, SceneReader } from "./SceneReader";
import type { GeoTransform } from "../render/orthorectify";
import {
  projectedGridToLngLatBounds,
  fromLngLat,
} from "../render/reproject";

/** A gridded scene in a projected, north-up CRS, ready to wrap as a reader. */
export interface ProjectedGridSource {
  /** Sensor name surfaced to the UI. */
  sensor: string;
  /** Grid columns (west→east). */
  width: number;
  /** Grid rows (north→south). */
  height: number;
  /** Number of spectral bands. */
  bandCount: number;
  /** Band center wavelengths in nanometres (length {@link bandCount}). */
  wavelengths: number[];
  /** Optional usable-band flags; defaults to all usable. */
  goodWavelengths?: boolean[];
  /** GDAL-style affine in the grid's projected CRS (metres). */
  gt: GeoTransform;
  /** EPSG code of the projected CRS (4326 if the grid is already geographic). */
  epsg: number;
  /** Read one band as a row-major raster (row 0 = north), length width*height, NaN for nodata. */
  readOrthoBand(bandIndex: number): Promise<Float32Array>;
  /** Read the full spectrum at integer grid indices, or null for nodata. */
  readSpectrumColRow(col: number, row: number): Promise<Float32Array | null>;
  /** Release underlying resources. */
  close(): void;
}

/**
 * Wrap a {@link ProjectedGridSource} as a {@link SceneReader}, handling the
 * projected→geographic bounds and the lng/lat→grid spectrum lookup.
 *
 * @param name - Human-readable scene name.
 * @param src - The gridded source.
 * @returns A reader the UI can drive exactly like the EMIT reader.
 */
export function makeProjectedGridReader(
  name: string,
  src: ProjectedGridSource,
): SceneReader {
  const bounds = projectedGridToLngLatBounds(src.gt, src.width, src.height, src.epsg);
  const [x0, dx, , y0, , dy] = src.gt;
  if (!Number.isFinite(dx) || dx === 0 || !Number.isFinite(dy) || dy === 0) {
    throw new Error(`Invalid affine pixel size (dx=${dx}, dy=${dy}); cannot map coordinates.`);
  }

  const metadata: SceneMetadata = {
    sensor: src.sensor,
    name,
    width: src.width,
    height: src.height,
    bandCount: src.bandCount,
    wavelengths: src.wavelengths,
    goodWavelengths: src.goodWavelengths ?? src.wavelengths.map(() => true),
    bounds,
    crs: `EPSG:${src.epsg}`,
  };

  let closed = false;

  return {
    metadata,

    async readOrthoBand(bandIndex: number): Promise<Float32Array> {
      if (closed) throw new Error("Scene has been closed.");
      const band = Math.max(0, Math.min(src.bandCount - 1, bandIndex));
      return src.readOrthoBand(band);
    },

    async readSpectrumAt(lng: number, lat: number): Promise<Float32Array | null> {
      if (closed) throw new Error("Scene has been closed.");
      const [x, y] = fromLngLat(src.epsg, lng, lat);
      const col = Math.floor((x - x0) / dx);
      const row = Math.floor((y - y0) / dy); // dy < 0 for a north-up grid
      if (col < 0 || col >= src.width || row < 0 || row >= src.height) return null;
      return src.readSpectrumColRow(col, row);
    },

    close(): void {
      if (closed) return;
      closed = true;
      src.close();
    },
  };
}
