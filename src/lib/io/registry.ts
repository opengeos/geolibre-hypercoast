/**
 * Sensor dispatch: turn raw scene bytes into the right {@link SceneReader}.
 *
 * The plugin supports every hyperspectral sensor HyperCoast reads, across three
 * container types. {@link openScene} first detects the container by magic bytes
 * (HDF5, TIFF, or classic netCDF), then either hands a TIFF to the GeoTIFF reader
 * or opens the HDF5 file once and sniffs its group layout to pick the sensor —
 * EMIT, PACE, NEON, PRISMA, Tanager, or AVIRIS. The chosen reader takes ownership
 * of the open handle and closes it.
 *
 * A caller may force a sensor (the UI's manual override) via `opts.sensor`,
 * bypassing the content sniff.
 */

import { openH5, closeH5, type OpenedH5 } from "./h5";
import type { SceneReader } from "./SceneReader";
import { isEmitScene, openEmitScene } from "./emit";
import {
  isNeonScene,
  openNeonScene,
  isPrismaScene,
  openPrismaScene,
  isAvirisNetcdfScene,
  openAvirisNetcdfScene,
} from "./h5-grid";
import { isPaceScene, openPaceScene, isTanagerScene, openTanagerScene } from "./swath";
import { openGeoTiffScene } from "./geotiff-scene";

/** A sensor offered in the UI's manual-override dropdown. */
export interface SensorInfo {
  /** Stable id; also the value forced via {@link OpenSceneOptions.sensor}. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Container the sensor is read from. */
  container: "hdf5" | "tiff";
}

/** All sensors the plugin can read (besides the "auto" default). */
export const SENSORS: readonly SensorInfo[] = [
  { id: "EMIT", label: "NASA EMIT (L2A)", container: "hdf5" },
  { id: "PACE", label: "NASA PACE OCI", container: "hdf5" },
  { id: "NEON", label: "NEON AOP", container: "hdf5" },
  { id: "PRISMA", label: "PRISMA L2D", container: "hdf5" },
  { id: "Tanager", label: "Planet Tanager", container: "hdf5" },
  { id: "AVIRIS", label: "AVIRIS-3/5", container: "hdf5" },
  { id: "DESIS", label: "DESIS", container: "tiff" },
  { id: "EnMAP", label: "EnMAP", container: "tiff" },
  { id: "Wyvern", label: "Wyvern", container: "tiff" },
];

/** Options for {@link openScene}. */
export interface OpenSceneOptions {
  /** Force a sensor id (UI override); "auto"/undefined auto-detects. */
  sensor?: string;
  /** Host hook to fetch a URL as bytes (for remote wavelength tables). */
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
}

type Container = "hdf5" | "tiff" | "netcdf-classic" | "unknown";

/** Detect the file container from its leading magic bytes. */
export function detectContainer(bytes: ArrayBuffer): Container {
  const u = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  // HDF5 superblock signature: \x89 H D F \r \n \x1a \n
  if (u[0] === 0x89 && u[1] === 0x48 && u[2] === 0x44 && u[3] === 0x46) return "hdf5";
  // TIFF / BigTIFF: "II" + 42|43, or "MM" + 42|43.
  if ((u[0] === 0x49 && u[1] === 0x49) || (u[0] === 0x4d && u[1] === 0x4d)) {
    const le = u[0] === 0x49;
    const magic = le ? u[2] | (u[3] << 8) : (u[2] << 8) | u[3];
    if (magic === 42 || magic === 43) return "tiff";
  }
  // Classic netCDF: "CDF" (unsupported — sensors use netCDF4/HDF5).
  if (u[0] === 0x43 && u[1] === 0x44 && u[2] === 0x46) return "netcdf-classic";
  return "unknown";
}

/** Sniffers and openers for the HDF5-backed sensors, in priority order. */
const HDF5_SENSORS: Array<{
  id: string;
  sniff: (f: OpenedH5["file"]) => boolean;
  open: (opened: OpenedH5, name: string) => Promise<SceneReader>;
}> = [
  { id: "EMIT", sniff: isEmitScene, open: openEmitScene },
  { id: "PACE", sniff: isPaceScene, open: openPaceScene },
  { id: "NEON", sniff: isNeonScene, open: openNeonScene },
  { id: "PRISMA", sniff: isPrismaScene, open: openPrismaScene },
  { id: "Tanager", sniff: isTanagerScene, open: openTanagerScene },
  { id: "AVIRIS", sniff: isAvirisNetcdfScene, open: openAvirisNetcdfScene },
];

/**
 * Open a hyperspectral scene from raw bytes, dispatching to the right sensor reader.
 *
 * @param bytes - The complete scene file contents (`.nc`/`.h5`/`.he5`/`.tif`).
 * @param name - Human-readable scene name (typically the file name).
 * @param opts - {@link OpenSceneOptions} (sensor override, fetch hook).
 * @returns A {@link SceneReader} for the detected/forced sensor.
 * @throws If the container is unsupported or no sensor matches.
 */
export async function openScene(
  bytes: ArrayBuffer,
  name: string,
  opts: OpenSceneOptions = {},
): Promise<SceneReader> {
  const container = detectContainer(bytes);
  const forced = opts.sensor && opts.sensor !== "auto" ? opts.sensor : null;

  if (container === "tiff") {
    return openGeoTiffScene(bytes, name, opts.fetchArrayBuffer, forced ?? undefined);
  }

  if (container === "hdf5") {
    const opened = await openH5(bytes);
    // Once an opener is invoked it owns the handle (and closes it on its own
    // failure). Until then — including if a sniff throws or nothing matches —
    // this function must close it. `dispatched` tracks that hand-off.
    let dispatched = false;
    try {
      if (forced) {
        const entry = HDF5_SENSORS.find((s) => s.id === forced);
        if (!entry) throw new Error(`Sensor "${forced}" is not an HDF5 sensor.`);
        dispatched = true;
        return await entry.open(opened, name);
      }
      for (const entry of HDF5_SENSORS) {
        if (entry.sniff(opened.file)) {
          dispatched = true;
          return await entry.open(opened, name);
        }
      }
      throw new Error(
        "Unrecognized HDF5/netCDF4 scene (not EMIT, PACE, NEON, PRISMA, Tanager, or AVIRIS).",
      );
    } catch (err) {
      if (!dispatched) closeH5(opened);
      throw err;
    }
  }

  if (container === "netcdf-classic") {
    throw new Error("Classic netCDF is not supported; this plugin reads netCDF4/HDF5 scenes.");
  }

  throw new Error("Unsupported file format (expected HDF5/netCDF4 or GeoTIFF).");
}
