/**
 * Readers for HDF5/netCDF4 hyperspectral sensors whose cubes are already gridded
 * in a projected CRS: NEON AOP (`.h5`), PRISMA L2D (`.he5`), and AVIRIS-3/5
 * orthocorrected NetCDF (`.nc`). All three share the {@link makeProjectedGridReader}
 * scaffolding; this module just locates each sensor's cube, wavelengths, scaling,
 * and affine, mirroring HyperCoast's `read_neon` / `read_prisma` / `read_aviris`.
 *
 * Bands and spectra are read lazily via HDF5 hyperslabs (like the EMIT reader),
 * so the full cube is never materialized in JS — only the requested band image or
 * single-pixel column is pulled out of WASM memory and scaled on the way.
 */

import {
  closeH5,
  h5Exists,
  h5FirstKey,
  h5NumberArray,
  h5AttrNumber,
  h5String,
  type Dataset,
  type OpenedH5,
} from "./h5";
import type { SceneReader } from "./SceneReader";
import { makeProjectedGridReader, type ProjectedGridSource } from "./grid-reader";
import type { GeoTransform } from "../render/orthorectify";

/** Coerce an h5wasm typed array (any dtype) to a Float32Array. */
function toFloat32(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (ArrayBuffer.isView(value)) {
    return Float32Array.from(value as unknown as ArrayLike<number>);
  }
  if (Array.isArray(value)) return Float32Array.from(value as number[]);
  throw new Error("Expected a numeric hyperslab result.");
}

// ---------------------------------------------------------------------------
// NEON AOP (.h5)
// ---------------------------------------------------------------------------

/** Detect a NEON AOP reflectance file: `<site>/Reflectance/Reflectance_Data`. */
export function isNeonScene(f: OpenedH5["file"]): boolean {
  const site = h5FirstKey(f);
  return Boolean(site && h5Exists(f, `${site}/Reflectance/Reflectance_Data`));
}

/**
 * Open a NEON AOP hyperspectral scene.
 *
 * @param opened - An open NEON `.h5` handle; the reader takes ownership.
 * @param name - Human-readable scene name.
 * @returns A {@link SceneReader} over the scene.
 */
export async function openNeonScene(opened: OpenedH5, name: string): Promise<SceneReader> {
  const f = opened.file;
  try {
    const site = h5FirstKey(f);
    if (!site) throw new Error("NEON file has no root site group.");
    const base = `${site}/Reflectance`;

    const cube = f.get(`${base}/Reflectance_Data`) as Dataset | null;
    if (!cube?.shape || cube.shape.length !== 3) {
      throw new Error("Missing or malformed NEON 'Reflectance_Data'.");
    }
    const [height, width, bandCount] = cube.shape;

    const wlDs = f.get(`${base}/Metadata/Spectral_Data/Wavelength`) as Dataset | null;
    if (!wlDs) throw new Error("Missing NEON 'Wavelength' dataset.");
    const wavelengths = h5NumberArray(wlDs.value).map((w) => Math.round(w * 100) / 100);

    const epsgDs = f.get(`${base}/Metadata/Coordinate_System/EPSG Code`) as Dataset | null;
    const epsg = parseInt(h5String(epsgDs?.value) ?? "", 10);
    if (!Number.isFinite(epsg)) throw new Error("Missing NEON EPSG code.");

    const miDs = f.get(`${base}/Metadata/Coordinate_System/Map_Info`) as Dataset | null;
    const mapInfo = (h5String(miDs?.value) ?? "").split(",").map((s) => s.trim());
    const xMin = parseFloat(mapInfo[3]);
    const yMax = parseFloat(mapInfo[4]);
    const xRes = parseFloat(mapInfo[5]);
    const yRes = parseFloat(mapInfo[6]);
    if (![xMin, yMax, xRes, yRes].every(Number.isFinite)) {
      throw new Error("Could not parse NEON Map_Info.");
    }
    const gt: GeoTransform = [xMin, xRes, 0, yMax, 0, -yRes];

    const scaleFactor = h5AttrNumber(cube.attrs, "Scale_Factor") ?? 1;
    const noData = h5AttrNumber(cube.attrs, "Data_Ignore_Value") ?? -9999;

    // NEON's read_neon masks the ignore value, negatives, and >10000, then divides
    // by the scale factor (Scale_Factor is typically 10000 → reflectance in 0..1).
    const scale = (v: number): number =>
      v === noData || v < 0 || v > 10000 ? NaN : v / scaleFactor;

    const source: ProjectedGridSource = {
      sensor: "NEON",
      width,
      height,
      bandCount,
      wavelengths,
      gt,
      epsg,
      async readOrthoBand(band: number): Promise<Float32Array> {
        const slab = toFloat32(
          cube.slice([[0, height], [0, width], [band, band + 1]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = scale(slab[i]);
        return slab;
      },
      async readSpectrumColRow(col: number, row: number): Promise<Float32Array | null> {
        const slab = toFloat32(
          cube.slice([[row, row + 1], [col, col + 1], [0, bandCount]]),
        );
        for (let i = 0; i < slab.length; i++) slab[i] = scale(slab[i]);
        return slab;
      },
      close: () => closeH5(opened),
    };
    return makeProjectedGridReader(name, source);
  } catch (err) {
    closeH5(opened);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PRISMA L2D (.he5)
// ---------------------------------------------------------------------------

const PRISMA_VNIR = "HDFEOS/SWATHS/PRS_L2D_HCO/Data Fields/VNIR_Cube";
const PRISMA_SWIR = "HDFEOS/SWATHS/PRS_L2D_HCO/Data Fields/SWIR_Cube";
const PRISMA_MAX = 65535;
const PRISMA_FILL = -9999;

/** Detect a PRISMA L2D file by its VNIR cube path. */
export function isPrismaScene(f: OpenedH5["file"]): boolean {
  return h5Exists(f, PRISMA_VNIR);
}

/** One global band's home: which detector cube and the band index within it. */
interface PrismaBand {
  detector: "vnir" | "swir";
  local: number;
}

/**
 * Open a PRISMA L2D hyperspectral scene.
 *
 * The VNIR and SWIR cubes are stored `(y, band, x)` as raw uint16 and rescaled
 * per-detector to reflectance (`min + raw/65535*(max-min)`). Bands from both
 * detectors are merged and sorted by ascending wavelength, dropping the ≤0
 * placeholder bands, exactly as HyperCoast's `read_prisma` does.
 *
 * @param opened - An open PRISMA `.he5` handle; the reader takes ownership.
 * @param name - Human-readable scene name.
 * @returns A {@link SceneReader} over the scene.
 */
export async function openPrismaScene(opened: OpenedH5, name: string): Promise<SceneReader> {
  const f = opened.file;
  try {
    const vnir = f.get(PRISMA_VNIR) as Dataset | null;
    const swir = f.get(PRISMA_SWIR) as Dataset | null;
    if (!vnir?.shape || !swir?.shape) throw new Error("Missing PRISMA VNIR/SWIR cubes.");
    if (vnir.shape.length !== 3 || swir.shape.length !== 3) {
      throw new Error("PRISMA VNIR/SWIR cubes must be 3-D (y, band, x).");
    }
    const [height, nVnir, width] = vnir.shape;
    const nSwir = swir.shape[1];
    // Both detectors must share the spatial grid so a band from either can be
    // scattered onto the same ortho grid and sampled at the same (col, row).
    if (swir.shape[0] !== height || swir.shape[2] !== width) {
      throw new Error(
        `PRISMA VNIR/SWIR spatial dims differ (VNIR ${height}x${width}, ` +
          `SWIR ${swir.shape[0]}x${swir.shape[2]}).`,
      );
    }

    const a = f.attrs;
    const vnirWl = h5NumberArray(a["List_Cw_Vnir"]?.value);
    const swirWl = h5NumberArray(a["List_Cw_Swir"]?.value);
    const vMin = h5AttrNumber(a, "L2ScaleVnirMin") ?? 0;
    const vMax = h5AttrNumber(a, "L2ScaleVnirMax") ?? 1;
    const sMin = h5AttrNumber(a, "L2ScaleSwirMin") ?? 0;
    const sMax = h5AttrNumber(a, "L2ScaleSwirMax") ?? 1;
    const epsg = h5AttrNumber(a, "Epsg_Code");
    const ulE = h5AttrNumber(a, "Product_ULcorner_easting");
    const ulN = h5AttrNumber(a, "Product_ULcorner_northing");
    const lrE = h5AttrNumber(a, "Product_LRcorner_easting");
    const lrN = h5AttrNumber(a, "Product_LRcorner_northing");
    if (epsg == null || ulE == null || ulN == null || lrE == null || lrN == null) {
      throw new Error("Missing PRISMA corner/EPSG attributes.");
    }

    // Build the merged, wavelength-sorted band list (drop ≤0 placeholders).
    const entries: Array<{ wl: number; band: PrismaBand }> = [];
    vnirWl.forEach((wl, i) => {
      if (wl > 0) entries.push({ wl, band: { detector: "vnir", local: i } });
    });
    swirWl.forEach((wl, i) => {
      if (wl > 0) entries.push({ wl, band: { detector: "swir", local: i } });
    });
    entries.sort((p, q) => p.wl - q.wl);
    const wavelengths = entries.map((e) => e.wl);
    const bandMap = entries.map((e) => e.band);
    const bandCount = bandMap.length;

    const xRes = (lrE - ulE) / width;
    const yRes = (lrN - ulN) / height; // negative for a north-up grid
    const gt: GeoTransform = [ulE, xRes, 0, ulN, 0, yRes];

    const rescale = (raw: number, lo: number, hi: number): number => {
      // Mask the fill sentinel on the raw sample, before rescaling, so a fill
      // value cannot map to a valid-looking reflectance.
      if (raw === PRISMA_FILL) return NaN;
      return lo + (raw / PRISMA_MAX) * (hi - lo);
    };

    const source: ProjectedGridSource = {
      sensor: "PRISMA",
      width,
      height,
      bandCount,
      wavelengths,
      gt,
      epsg,
      async readOrthoBand(band: number): Promise<Float32Array> {
        const { detector, local } = bandMap[band];
        const cube = detector === "vnir" ? vnir : swir;
        const lo = detector === "vnir" ? vMin : sMin;
        const hi = detector === "vnir" ? vMax : sMax;
        // (y, band, x) → slab of shape (height, 1, width), row-major y*width + x.
        const slab = toFloat32(cube.slice([[0, height], [local, local + 1], [0, width]]));
        for (let i = 0; i < slab.length; i++) slab[i] = rescale(slab[i], lo, hi);
        return slab;
      },
      async readSpectrumColRow(col: number, row: number): Promise<Float32Array | null> {
        // Pull each detector's full band column at (row, col) in one slab.
        const vCol = toFloat32(vnir.slice([[row, row + 1], [0, nVnir], [col, col + 1]]));
        const sCol = toFloat32(swir.slice([[row, row + 1], [0, nSwir], [col, col + 1]]));
        const out = new Float32Array(bandCount);
        for (let i = 0; i < bandCount; i++) {
          const { detector, local } = bandMap[i];
          out[i] =
            detector === "vnir"
              ? rescale(vCol[local], vMin, vMax)
              : rescale(sCol[local], sMin, sMax);
        }
        return out;
      },
      close: () => closeH5(opened),
    };
    return makeProjectedGridReader(name, source);
  } catch (err) {
    closeH5(opened);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// AVIRIS-3/5 orthocorrected NetCDF (.nc)
// ---------------------------------------------------------------------------

/** Resolve the first existing dataset among candidate paths. */
function firstDataset(f: OpenedH5["file"], paths: string[]): Dataset | null {
  for (const p of paths) {
    const ds = f.get(p) as Dataset | null;
    if (ds) return ds;
  }
  return null;
}

/** Detect an AVIRIS-3/5 orthocorrected NetCDF (group `reflectance`). */
export function isAvirisNetcdfScene(f: OpenedH5["file"]): boolean {
  return (
    h5Exists(f, "reflectance/reflectance") ||
    h5Exists(f, "reflectance/rfl") ||
    h5Exists(f, "reflectance/surface_reflectance")
  );
}

/**
 * Open an AVIRIS-3/5 orthocorrected NetCDF scene.
 *
 * Mirrors HyperCoast's `_normalize_aviris_netcdf`: the reflectance cube lives in
 * the `reflectance` group (bands-last `(y, x, band)`); easting/northing coordinate
 * arrays give the affine; the CRS comes from a CF grid-mapping variable's WKT.
 *
 * @param opened - An open AVIRIS `.nc` handle; the reader takes ownership.
 * @param name - Human-readable scene name.
 * @returns A {@link SceneReader} over the scene.
 */
export async function openAvirisNetcdfScene(
  opened: OpenedH5,
  name: string,
): Promise<SceneReader> {
  const f = opened.file;
  try {
    const cube = firstDataset(f, [
      "reflectance/reflectance",
      "reflectance/rfl",
      "reflectance/surface_reflectance",
    ]);
    if (!cube?.shape || cube.shape.length !== 3) {
      throw new Error("Missing or malformed AVIRIS 'reflectance' cube.");
    }
    const [height, width, bandCount] = cube.shape;

    const wlDs = firstDataset(f, [
      "reflectance/wavelength",
      "wavelength",
      "sensor_band_parameters/wavelength",
    ]);
    if (!wlDs) throw new Error("Missing AVIRIS 'wavelength' coordinate.");
    const wavelengths = h5NumberArray(wlDs.value).map((w) => Math.round(w * 100) / 100);

    const xDs = firstDataset(f, ["reflectance/easting", "easting", "reflectance/x", "x"]);
    const yDs = firstDataset(f, ["reflectance/northing", "northing", "reflectance/y", "y"]);
    if (!xDs || !yDs) throw new Error("Missing AVIRIS easting/northing coordinates.");
    const xs = h5NumberArray(xDs.value);
    const ys = h5NumberArray(yDs.value);
    // Cell-center coords → outer-corner affine (origin at the NW pixel corner).
    const dx = xs.length > 1 ? xs[1] - xs[0] : 1;
    const dy = ys.length > 1 ? ys[1] - ys[0] : -1;
    const gt: GeoTransform = [xs[0] - dx / 2, dx, 0, ys[0] - dy / 2, 0, dy];

    const epsg = findCfEpsg(f) ?? 4326;
    const fill = h5AttrNumber(cube.attrs, "_FillValue") ?? -9999;
    const mask = (v: number): number => (v === fill ? NaN : v);

    const source: ProjectedGridSource = {
      sensor: "AVIRIS",
      width,
      height,
      bandCount,
      wavelengths,
      gt,
      epsg,
      async readOrthoBand(band: number): Promise<Float32Array> {
        const slab = toFloat32(cube.slice([[0, height], [0, width], [band, band + 1]]));
        for (let i = 0; i < slab.length; i++) slab[i] = mask(slab[i]);
        return slab;
      },
      async readSpectrumColRow(col: number, row: number): Promise<Float32Array | null> {
        const slab = toFloat32(cube.slice([[row, row + 1], [col, col + 1], [0, bandCount]]));
        for (let i = 0; i < slab.length; i++) slab[i] = mask(slab[i]);
        return slab;
      },
      close: () => closeH5(opened),
    };
    return makeProjectedGridReader(name, source);
  } catch (err) {
    closeH5(opened);
    throw err;
  }
}

/**
 * Find an EPSG code from a CF grid-mapping variable. AVIRIS NetCDF stores the CRS
 * on a scalar variable whose attributes carry a WKT string (`crs_wkt` /
 * `spatial_ref`) or a `grid_mapping_name`; we pull the EPSG out of the WKT.
 */
function findCfEpsg(f: OpenedH5["file"]): number | null {
  for (const key of ["crs", "transverse_mercator", "spatial_ref", "grid_mapping"]) {
    const v = f.get(`reflectance/${key}`) ?? f.get(key);
    const attrs = (v as { attrs?: Record<string, { value: unknown }> } | null)?.attrs;
    if (!attrs) continue;
    for (const attr of ["crs_wkt", "spatial_ref", "wkt"]) {
      const wkt = h5String(attrs[attr]?.value);
      if (wkt) {
        const m = wkt.match(/ID\["EPSG",\s*(\d{4,6})\]\s*\]?\s*$/) ||
          wkt.match(/AUTHORITY\["EPSG",\s*"?(\d{4,6})"?\]/g)?.slice(-1)[0]?.match(/(\d{4,6})/);
        if (m) return parseInt(m[1], 10);
      }
    }
    const code = h5AttrNumber(attrs, "epsg_code") ?? h5AttrNumber(attrs, "spatial_epsg");
    if (code) return code;
  }
  return null;
}
