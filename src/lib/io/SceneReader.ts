/**
 * Sensor-agnostic interface for reading a hyperspectral scene.
 *
 * A {@link SceneReader} hides each sensor's storage and georeferencing details
 * behind two operations the UI needs: read an orthorectified band (for the RGB
 * composite) and read a full spectrum at a geographic point (for the spectral
 * inspector). EMIT is the first implementation (see `emit.ts`); PACE and GeoTIFF
 * sensors will provide their own readers behind the same interface.
 */

import type { Bounds } from "../render/orthorectify";

/** Description of a loaded scene, surfaced to the UI. */
export interface SceneMetadata {
  /** Sensor name, e.g. "EMIT". */
  sensor: string;
  /** Human-readable scene name (typically the granule/file name). */
  name: string;
  /** Orthorectified grid width (columns), west→east. */
  width: number;
  /** Orthorectified grid height (rows), north→south. */
  height: number;
  /** Number of spectral bands. */
  bandCount: number;
  /** Center wavelength of each band, in nanometres (length {@link bandCount}). */
  wavelengths: number[];
  /**
   * Whether each band is flagged usable (length {@link bandCount}). Bands marked
   * unusable (e.g. EMIT water-absorption bands) are set to NaN in spectra.
   */
  goodWavelengths: boolean[];
  /** Geographic extent of the ortho grid as [west, south, east, north], EPSG:4326. */
  bounds: Bounds;
  /**
   * The scene's native CRS as an "EPSG:<code>" string, for display only. The
   * reader reprojects internally, so {@link bounds} is always EPSG:4326 and the
   * UI never needs this; it is surfaced purely for the scene-info line.
   */
  crs?: string;
}

/** Reads bands and spectra from a single loaded scene. */
export interface SceneReader {
  /** Metadata describing the scene. */
  readonly metadata: SceneMetadata;
  /**
   * Read one band, orthorectified onto the scene's grid.
   *
   * @param bandIndex - Zero-based band index.
   * @returns A row-major raster (row 0 = north), length width*height, with NaN
   *   for cells that have no data.
   */
  readOrthoBand(bandIndex: number): Promise<Float32Array>;
  /**
   * Read the full spectrum at a geographic location.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The per-band reflectance (length bandCount), with NaN for fill and
   *   unusable bands, or `null` if the point falls outside the scene or on a
   *   nodata cell.
   */
  readSpectrumAt(lng: number, lat: number): Promise<Float32Array | null>;
  /** Release the underlying resources (closes the file, frees WASM memory). */
  close(): void;
}

/**
 * Find the band whose center wavelength is closest to a target.
 *
 * @param wavelengths - Band center wavelengths in nanometres.
 * @param targetNm - Desired wavelength in nanometres.
 * @returns The index of the nearest band (0 when `wavelengths` is empty).
 */
export function nearestBandIndex(
  wavelengths: readonly number[],
  targetNm: number,
): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < wavelengths.length; i++) {
    const diff = Math.abs(wavelengths[i] - targetNm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}
