/**
 * Thin wrapper around h5wasm for reading HDF5 / netCDF4 files in the browser.
 *
 * h5wasm is a WebAssembly build of libHDF5. Its ESM build embeds the `.wasm`
 * binary directly in the JS (a single-file build), so nothing extra needs to be
 * shipped or resolved at runtime: importing it is enough. The WASM runtime is
 * initialized lazily, only when the first scene is opened.
 *
 * Files are read through an in-memory Emscripten filesystem (MEMFS): the whole
 * file is written into WASM memory once, then HDF5 hyperslab reads pull only the
 * sub-regions a caller asks for (a single band, a single pixel's spectrum). This
 * keeps per-read cost low, at the cost of holding the whole file in memory for
 * the lifetime of the handle. Multi-gigabyte EMIT granules load fine in a
 * 64-bit browser process; see {@link openH5} for the memory note.
 */

import { ready, FS, File as H5File, type Dataset, type Group } from "h5wasm";

let initPromise: Promise<void> | null = null;
let fileCounter = 0;

/** A file opened in the in-memory filesystem, plus its MEMFS path for cleanup. */
export interface OpenedH5 {
  file: H5File;
  path: string;
}

/**
 * Initialize the h5wasm runtime. Idempotent and safe to call repeatedly; the
 * underlying promise is created once and reused.
 */
export async function initH5(): Promise<void> {
  if (!initPromise) {
    initPromise = ready.then(() => undefined);
  }
  return initPromise;
}

/**
 * Write a file's bytes into MEMFS and open it read-only.
 *
 * Caller should drop its reference to `bytes` immediately after this resolves:
 * the data now lives in WASM memory, so keeping the original `ArrayBuffer` around
 * doubles peak memory (host copy + WASM copy) for the duration.
 *
 * @param bytes - The complete file contents.
 * @returns The opened file handle and its MEMFS path.
 */
export async function openH5(bytes: ArrayBuffer): Promise<OpenedH5> {
  await initH5();
  if (!FS) throw new Error("h5wasm filesystem is not available after init.");
  const path = `/scene_${fileCounter++}.h5`;
  FS.writeFile(path, new Uint8Array(bytes));
  const file = new H5File(path, "r");
  return { file, path };
}

/**
 * Test whether a dataset or group exists at the given path in an open file.
 *
 * @param file - An open h5wasm file.
 * @param path - An HDF5 path (e.g. "navigation_data/longitude").
 * @returns True if something resolves at that path.
 */
export function h5Exists(file: H5File, path: string): boolean {
  try {
    return file.get(path) != null;
  } catch {
    return false;
  }
}

/**
 * Return the first child key under a group path (or the root when no path is
 * given). Useful for sensors that namespace data under a dynamic key (e.g. NEON
 * stores everything under the site code).
 *
 * @param file - An open h5wasm file.
 * @param path - A group path, or undefined for the root group.
 * @returns The first child key, or null if the group is missing/empty.
 */
export function h5FirstKey(file: H5File, path?: string): string | null {
  try {
    const node = (path ? file.get(path) : file) as Group | H5File | null;
    const keys = node && "keys" in node ? node.keys() : null;
    return keys && keys.length > 0 ? keys[0] : null;
  } catch {
    return null;
  }
}

/** Read a numeric HDF5 dataset or attribute value as a plain `number[]`. */
export function h5NumberArray(value: unknown): number[] {
  if (
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Int8Array ||
    value instanceof Int16Array ||
    value instanceof Int32Array ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
  ) {
    return Array.from(value);
  }
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "number") return [value];
  throw new Error("Expected a numeric array value.");
}

/** Whether a typed-array view holds BigInt elements (not coercible to `number`). */
function isBigIntView(v: ArrayBufferView): boolean {
  return v instanceof BigInt64Array || v instanceof BigUint64Array;
}

/** Read a scalar numeric attribute from a file or dataset, or null if absent. */
export function h5AttrNumber(attrs: Record<string, { value: unknown }>, key: string): number | null {
  const a = attrs[key];
  if (!a) return null;
  const v = a.value;
  if (typeof v === "number") return v;
  // Any numeric typed array (Int8/16/32, Uint8/16/32, Float32/64); BigInt views
  // are excluded since their elements aren't `number`.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView) && !isBigIntView(v)) {
    const arr = v as unknown as ArrayLike<number>;
    return arr.length > 0 ? Number(arr[0]) : null;
  }
  if (Array.isArray(v) && v.length > 0) return Number(v[0]);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Decode an HDF5 string attribute/value (handles byte strings), or null. */
export function h5String(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  if (value == null) return null;
  return String(value);
}

export type { Dataset, Group };

/**
 * Close a file handle and remove its bytes from MEMFS, freeing the WASM memory.
 *
 * @param opened - The handle returned by {@link openH5}.
 */
export function closeH5(opened: OpenedH5): void {
  try {
    opened.file.close();
  } catch {
    // Ignore: the file may already be closed.
  }
  try {
    FS?.unlink(opened.path);
  } catch {
    // Ignore: the path may already be gone.
  }
}
