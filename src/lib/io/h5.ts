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

import { ready, FS, File as H5File } from "h5wasm";

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
