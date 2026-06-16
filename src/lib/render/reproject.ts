/**
 * Coordinate reprojection for sensors stored in a projected CRS (almost always a
 * UTM zone). The map overlay places the RGB image as an EPSG:4326 lng/lat quad
 * (see `RasterOverlay.setImage`), but most non-EMIT hyperspectral products grid
 * their pixels in projected metres. These helpers convert a projected affine grid
 * to the geographic bounds the overlay needs, and convert clicked lng/lat back to
 * projected metres for the spectral inspector.
 *
 * `proj4` ships definitions for EPSG:4326 only; UTM and other codes are
 * registered on demand. UTM codes follow a fixed pattern (326xx = WGS84 / UTM
 * zone xx N, 327xx = zone xx S), so their proj strings are synthesized directly.
 * Other EPSG codes raise a clear error rather than silently misplacing a scene.
 */

import proj4 from "proj4";
import type { GeoTransform, Bounds } from "./orthorectify";

const WGS84 = "EPSG:4326";

/** Build a `proj4` definition string for an EPSG code, or null if unsupported. */
function epsgToProj4(epsg: number): string | null {
  if (epsg === 4326) return WGS84;
  // WGS84 / UTM north (326zz) and south (327zz).
  if (epsg >= 32601 && epsg <= 32660) {
    const zone = epsg - 32600;
    return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
  }
  if (epsg >= 32701 && epsg <= 32760) {
    const zone = epsg - 32700;
    return `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`;
  }
  return null;
}

const registered = new Set<string>([WGS84]);

/**
 * Ensure a `proj4` definition is registered for an EPSG code and return its name.
 *
 * @param epsg - EPSG code of the projected (or geographic) CRS.
 * @returns The CRS name to pass to `proj4` (e.g. "EPSG:32617").
 * @throws If the EPSG code is not EPSG:4326 or a WGS84/UTM zone.
 */
export function ensureCrs(epsg: number): string {
  const name = `EPSG:${epsg}`;
  if (registered.has(name)) return name;
  const def = epsgToProj4(epsg);
  if (!def) {
    throw new Error(
      `Unsupported CRS EPSG:${epsg}. Only EPSG:4326 and WGS84/UTM zones are supported.`,
    );
  }
  proj4.defs(name, def);
  registered.add(name);
  return name;
}

/** Parse an EPSG code out of a CRS string ("EPSG:32617", a WKT, or a proj string). */
export function parseEpsg(crs: string | number | null | undefined): number | null {
  if (crs == null) return null;
  if (typeof crs === "number") return Number.isFinite(crs) ? crs : null;
  const m = crs.match(/EPSG[:"\s,]+(\d{4,6})/i);
  if (m) return parseInt(m[1], 10);
  const trailing = crs.match(/(\d{4,6})\s*\]?\s*$/);
  return trailing ? parseInt(trailing[1], 10) : null;
}

/**
 * Convert a projected coordinate to lng/lat.
 *
 * @param epsg - EPSG code of the source projected CRS.
 * @param x - Easting (metres).
 * @param y - Northing (metres).
 * @returns `[lng, lat]` in EPSG:4326.
 */
export function toLngLat(epsg: number, x: number, y: number): [number, number] {
  if (epsg === 4326) return [x, y];
  const src = ensureCrs(epsg);
  const [lng, lat] = proj4(src, WGS84, [x, y]);
  return [lng, lat];
}

/**
 * Convert a lng/lat to projected metres in the given CRS.
 *
 * @param epsg - EPSG code of the target projected CRS.
 * @param lng - Longitude (degrees).
 * @param lat - Latitude (degrees).
 * @returns `[x, y]` easting/northing in metres (or the lng/lat unchanged for 4326).
 */
export function fromLngLat(epsg: number, lng: number, lat: number): [number, number] {
  if (epsg === 4326) return [lng, lat];
  const dst = ensureCrs(epsg);
  const [x, y] = proj4(WGS84, dst, [lng, lat]);
  return [x, y];
}

/**
 * Compute the geographic bounding box of a projected, north-up affine grid by
 * reprojecting its four corners and taking their extent.
 *
 * For a UTM grid the reprojected footprint is a slightly curved quadrilateral;
 * the overlay only needs an axis-aligned bbox, and at scene scale the corner
 * extent is a faithful placement (the same lat/lon-quad approximation EMIT uses).
 *
 * @param gt - GDAL-style affine `[x0, dx, rx, y0, ry, dy]` in projected metres.
 * @param width - Grid columns.
 * @param height - Grid rows.
 * @param epsg - EPSG code of the grid's projected CRS.
 * @returns Bounds `[west, south, east, north]` in EPSG:4326.
 */
export function projectedGridToLngLatBounds(
  gt: GeoTransform,
  width: number,
  height: number,
  epsg: number,
): Bounds {
  const [x0, dx, rx, y0, ry, dy] = gt;
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x0 + width * dx, y0 + width * ry],
    [x0 + height * rx, y0 + height * dy],
    [x0 + width * dx + height * rx, y0 + width * ry + height * dy],
  ];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [px, py] of corners) {
    const [lng, lat] = toLngLat(epsg, px, py);
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}
