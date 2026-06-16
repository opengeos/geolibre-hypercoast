/**
 * Pure raster math for orthorectifying EMIT swath data and composing an RGB
 * image. None of these functions touch the DOM, MapLibre, or h5wasm, so they are
 * fully unit-testable.
 *
 * EMIT L2A reflectance ships in sensor (swath) geometry. The file's `location`
 * group carries a Geometry Lookup Table (GLT): two integer arrays, `glt_x`
 * (crosstrack/column index) and `glt_y` (downtrack/row index), each sized to the
 * orthorectified grid. A root `geotransform` attribute (a GDAL-style affine in
 * EPSG:4326) places that grid geographically. {@link applyGlt} scatters swath
 * pixels onto the ortho grid; the geotransform helpers convert between geographic
 * coordinates and ortho grid indices.
 *
 * Algorithm adapted from NASA's EMIT-Data-Resources (Apache-2.0) by way of
 * HyperCoast's `emit_xarray`/`apply_glt`.
 */

/** GDAL-style 6-element affine geotransform: [x0, dx, rx, y0, ry, dy]. */
export type GeoTransform = [number, number, number, number, number, number];

/** Geographic extent as [west, south, east, north] in EPSG:4326. */
export type Bounds = [number, number, number, number];

/** Value EMIT uses for missing reflectance samples. */
export const EMIT_FILL_VALUE = -9999;

/** Value the GLT uses to mark ortho cells with no underlying swath pixel. */
export const GLT_NODATA = 0;

/**
 * Compute the geographic bounds of a grid given its geotransform and size.
 *
 * Assumes north-up (no rotation), as EMIT data is. The geotransform origin is
 * the outer corner of the top-left pixel, so the extent spans the full grid.
 *
 * @param gt - The 6-element geotransform.
 * @param width - Number of grid columns.
 * @param height - Number of grid rows.
 * @returns Bounds as [west, south, east, north].
 */
export function geotransformToBounds(
  gt: GeoTransform,
  width: number,
  height: number,
): Bounds {
  const [x0, dx, , y0, , dy] = gt;
  const west = x0;
  const north = y0;
  const east = x0 + width * dx;
  const south = y0 + height * dy; // dy is negative for a north-up grid
  return [west, south, east, north];
}

/**
 * Convert a geographic coordinate to integer ortho grid indices.
 *
 * Inverts the geotransform (ignoring rotation, which is zero for EMIT) and
 * floors to the containing pixel. The returned indices may fall outside the
 * grid; callers must bounds-check against the grid width/height.
 *
 * @param gt - The 6-element geotransform.
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns The column and row indices of the containing cell.
 */
export function lngLatToColRow(
  gt: GeoTransform,
  lng: number,
  lat: number,
): { col: number; row: number } {
  const [x0, dx, , y0, , dy] = gt;
  // `+ 0` normalizes a possible -0 (e.g. exactly on the top/left edge) to 0.
  const col = Math.floor((lng - x0) / dx) + 0;
  const row = Math.floor((lat - y0) / dy) + 0;
  return { col, row };
}

/**
 * Orthorectify a single swath band by scattering its pixels onto the ortho grid
 * defined by the GLT.
 *
 * @param band - The swath band, row-major [downtrack, crosstrack], length swathH*swathW.
 * @param swathW - Crosstrack (column) count of the swath.
 * @param swathH - Downtrack (row) count of the swath.
 * @param gltX - GLT crosstrack indices (1-based, 0 = nodata), row-major, length gltH*gltW.
 * @param gltY - GLT downtrack indices (1-based, 0 = nodata), row-major, length gltH*gltW.
 * @param gltW - Ortho grid column count.
 * @param gltH - Ortho grid row count.
 * @param fillValue - Swath fill value to treat as missing (default {@link EMIT_FILL_VALUE}).
 * @returns The ortho raster, row-major [north→south, west→east], length gltH*gltW, with NaN for missing cells.
 */
export function applyGlt(
  band: Float32Array | Int16Array | Float64Array,
  swathW: number,
  swathH: number,
  gltX: Int32Array | Int16Array | Float32Array,
  gltY: Int32Array | Int16Array | Float32Array,
  gltW: number,
  gltH: number,
  fillValue: number = EMIT_FILL_VALUE,
): Float32Array {
  const out = new Float32Array(gltW * gltH);
  out.fill(NaN);

  const n = gltW * gltH;
  for (let i = 0; i < n; i++) {
    const gx = gltX[i];
    const gy = gltY[i];
    if (gx === GLT_NODATA || gy === GLT_NODATA) continue;

    const sx = gx - 1; // crosstrack (column)
    const sy = gy - 1; // downtrack (row)
    if (sx < 0 || sx >= swathW || sy < 0 || sy >= swathH) continue;

    const v = band[sy * swathW + sx];
    out[i] = v === fillValue ? NaN : v;
  }
  return out;
}

/**
 * Compose three orthorectified bands into an RGBA buffer with a per-channel
 * linear stretch. Cells that are NaN in the red band are treated as nodata and
 * rendered fully transparent (the GLT drops whole pixels, so all bands share the
 * same nodata mask).
 *
 * Returns a raw `Uint8ClampedArray` (length width*height*4) rather than an
 * `ImageData` so the function stays DOM-free and testable; the caller wraps it.
 *
 * @param r - Red ortho band (length width*height).
 * @param g - Green ortho band.
 * @param b - Blue ortho band.
 * @param stretchMin - Lower reflectance bound mapped to 0.
 * @param stretchMax - Upper reflectance bound mapped to 255.
 * @returns RGBA pixel data, row-major, length width*height*4.
 */
export function composeRgb(
  r: Float32Array,
  g: Float32Array,
  b: Float32Array,
  stretchMin: number,
  stretchMax: number,
): Uint8ClampedArray {
  const n = r.length;
  const rgba = new Uint8ClampedArray(n * 4);
  const range = stretchMax - stretchMin || 1;

  const scale = (v: number): number => {
    if (Number.isNaN(v)) return 0;
    const t = (v - stretchMin) / range;
    return t <= 0 ? 0 : t >= 1 ? 255 : t * 255;
  };

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Number.isNaN(r[i])) {
      rgba[o + 3] = 0; // transparent nodata
      continue;
    }
    rgba[o] = scale(r[i]);
    rgba[o + 1] = scale(g[i]);
    rgba[o + 2] = scale(b[i]);
    rgba[o + 3] = 255;
  }
  return rgba;
}
