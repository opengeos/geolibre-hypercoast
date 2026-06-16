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
 * A resampling plan that maps a regular EPSG:4326 target grid back to swath
 * pixels, for sensors that georeference with 2-D per-pixel latitude/longitude
 * arrays (PACE, Tanager) rather than a GLT or affine.
 */
export interface SwathGrid {
  /** Target grid columns (west→east). */
  width: number;
  /** Target grid rows (north→south). */
  height: number;
  /** Geographic extent as [west, south, east, north]. */
  bounds: Bounds;
  /** GDAL-style affine of the target grid (EPSG:4326). */
  gt: GeoTransform;
  /**
   * For each target cell (row-major), the flat swath index `sy*swathW + sx` of
   * the pixel that lands there, or -1 if the cell has no contributing pixel.
   */
  srcIndex: Int32Array;
}

/**
 * Build a forward-scatter resampling plan from per-pixel lon/lat arrays.
 *
 * The target grid spans the lon/lat bounding box of the valid swath pixels and
 * is sized to roughly the swath's pixel count, so most cells receive exactly one
 * pixel; cells with none stay -1 (rendered transparent). Each swath pixel is
 * mapped to its containing target cell (last writer wins) — the lat/lon analogue
 * of {@link applyGlt}.
 *
 * @param lon - Per-pixel longitudes, row-major [downtrack, crosstrack], length swathW*swathH.
 * @param lat - Per-pixel latitudes, same layout.
 * @param swathW - Crosstrack (column) count.
 * @param swathH - Downtrack (row) count.
 * @returns The {@link SwathGrid} resampling plan.
 * @throws If no swath pixel has a valid geolocation.
 */
export function buildSwathGrid(
  lon: ArrayLike<number>,
  lat: ArrayLike<number>,
  swathW: number,
  swathH: number,
): SwathGrid {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const valid = (lng: number, la: number): boolean =>
    Number.isFinite(lng) && Number.isFinite(la) && Math.abs(lng) <= 180 && Math.abs(la) <= 90;

  const n = swathW * swathH;
  for (let i = 0; i < n; i++) {
    const lng = lon[i];
    const la = lat[i];
    if (!valid(lng, la)) continue;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (la < south) south = la;
    if (la > north) north = la;
  }
  if (!Number.isFinite(west)) throw new Error("Swath has no valid geolocation.");

  const width = swathW;
  const height = swathH;
  const spanX = east - west || 1e-9;
  const spanY = north - south || 1e-9;
  const dx = spanX / width;
  const dy = spanY / height;

  const srcIndex = new Int32Array(width * height).fill(-1);
  for (let i = 0; i < n; i++) {
    const lng = lon[i];
    const la = lat[i];
    if (!valid(lng, la)) continue;
    let col = Math.floor((lng - west) / dx);
    let row = Math.floor((north - la) / dy);
    if (col === width) col = width - 1;
    if (row === height) row = height - 1;
    if (col < 0 || col >= width || row < 0 || row >= height) continue;
    srcIndex[row * width + col] = i;
  }

  const gt: GeoTransform = [west, dx, 0, north, 0, -dy];
  return { width, height, bounds: [west, south, east, north], gt, srcIndex };
}

/**
 * Convert a lng/lat to integer cell indices on a {@link SwathGrid}.
 *
 * @param grid - The target grid.
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns The column/row of the containing cell (may be out of range).
 */
export function swathGridColRow(
  grid: SwathGrid,
  lng: number,
  lat: number,
): { col: number; row: number } {
  const [west, dx, , north, , dy] = grid.gt;
  const col = Math.floor((lng - west) / dx);
  const row = Math.floor((lat - north) / dy); // dy < 0
  return { col, row };
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
