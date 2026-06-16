/**
 * Wavelength resolution for GeoTIFF sensors that do not store band center
 * wavelengths in the raster itself. HyperCoast fetches these from CSVs published
 * in the `opengeos/datasets` release (keyed by sensor / band count). This module
 * mirrors that, but layers three sources so the plugin works offline too:
 *
 *   1. wavelengths embedded in the GeoTIFF's band tags (Wyvern `long_name`,
 *      EnMAP `wavelength`) — preferred when present and complete;
 *   2. the remote CSV (same URLs HyperCoast uses), fetched via the host's
 *      `fetchArrayBuffer`;
 *   3. a bundled copy of the known tables, so a failed/blocked fetch still yields
 *      correct wavelengths.
 *
 * If every source fails, band indices (1..N) are returned so the scene still
 * loads — the RGB sliders just operate on band numbers instead of nanometres.
 */

const RELEASE = "https://github.com/opengeos/datasets/releases/download/hypercoast";

/** DESIS L2A band centers (nm), 235 bands — bundled copy of `desis_wavelengths.csv`. */
export const DESIS_WAVELENGTHS: number[] = [
  401.43, 404.1, 406.72, 409.23, 411.71, 414.24, 416.81, 419.34, 421.91, 424.54, 427.19,
  429.76, 432.35, 434.88, 437.39, 439.85, 442.39, 444.92, 447.66, 450.24, 452.79, 455.47,
  458.08, 460.65, 463.18, 465.72, 468.2, 470.67, 473.26, 475.77, 478.47, 481.14, 483.7,
  486.29, 488.89, 491.45, 493.87, 496.4, 499.14, 501.65, 504.22, 506.82, 509.44, 512.05,
  514.59, 517.07, 519.56, 522.09, 524.59, 527.12, 529.66, 532.23, 534.83, 537.46, 540.05,
  542.59, 545.11, 547.66, 550.28, 552.81, 555.46, 557.98, 560.52, 563.08, 565.69, 568.31,
  570.9, 573.48, 576.0, 578.5, 581.03, 583.56, 586.13, 588.68, 591.24, 593.86, 596.48,
  598.94, 601.51, 604.09, 606.65, 609.16, 611.7, 614.24, 616.8, 619.42, 622.01, 624.61,
  627.08, 629.56, 632.12, 634.62, 637.14, 639.66, 642.22, 644.85, 647.47, 649.92, 652.49,
  655.14, 657.62, 660.12, 662.66, 665.2, 667.75, 670.38, 673.06, 675.7, 678.26, 680.81,
  683.37, 685.77, 688.32, 690.78, 693.37, 696.01, 698.72, 701.31, 703.82, 706.64, 709.27,
  711.68, 713.92, 716.27, 718.79, 721.45, 724.11, 726.75, 729.35, 731.93, 734.27, 736.8,
  739.4, 741.89, 744.42, 747.03, 749.64, 752.17, 755.07, 757.64, 760.23, 762.86, 764.81,
  767.47, 770.23, 772.61, 775.24, 777.9, 780.49, 782.98, 785.48, 788.16, 790.47, 793.07,
  795.8, 798.27, 801.06, 803.98, 806.57, 809.05, 811.6, 814.16, 816.78, 819.66, 822.71,
  824.16, 827.07, 829.08, 832.1, 834.78, 836.59, 839.97, 841.87, 844.56, 847.63, 849.83,
  852.36, 855.27, 857.78, 860.2, 862.77, 865.34, 867.87, 870.49, 873.08, 875.67, 878.66,
  881.42, 882.98, 885.21, 887.98, 890.82, 893.95, 895.87, 898.26, 901.1, 903.66, 905.88,
  908.53, 911.52, 914.67, 916.46, 918.28, 920.83, 923.74, 926.97, 929.56, 931.75, 934.39,
  937.19, 939.3, 941.82, 944.64, 947.18, 949.48, 951.8, 954.12, 957.21, 959.47, 962.2,
  965.32, 968.0, 970.33, 972.8, 975.93, 978.52, 979.9, 981.89, 984.74, 988.77, 991.56,
  993.05, 995.54, 997.82, 999.98,
];

/** Wyvern Dragonette-1 band centers (nm), 23 bands. */
export const WYVERN_DRAGONETTE1: number[] = [
  503, 510, 519, 535, 549, 570, 584, 600, 614, 635, 649, 660, 669, 679, 690, 699, 711, 722,
  734, 750, 764, 782, 799,
];

/** Wyvern Dragonette-3 band centers (nm), 31 bands. */
export const WYVERN_DRAGONETTE3: number[] = [
  445, 464, 480, 490, 503, 510, 519, 534, 550, 569, 585, 600, 614, 634, 650, 659, 669, 679,
  689, 700, 712, 722, 734, 749, 764, 781, 799, 814, 832, 849, 869,
];

/** Parse a `band,wavelength` CSV (BOM-tolerant) into the wavelength column. */
export function parseWavelengthCsv(text: string): number[] {
  const out: number[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const cols = line.split(",");
    if (cols.length < 2) continue;
    const wl = parseFloat(cols[1]);
    if (Number.isFinite(wl)) out.push(wl);
  }
  return out;
}

/** The remote CSV URL for a sensor/band-count, or null when there is none. */
function csvUrlFor(sensor: string, bandCount: number): string | null {
  if (sensor === "DESIS") return `${RELEASE}/desis_wavelengths.csv`;
  if (sensor === "Wyvern" && bandCount === 23) {
    return `${RELEASE}/wyvern_dragonette-1_wavelengths.csv`;
  }
  if (sensor === "Wyvern" && bandCount === 31) {
    return `${RELEASE}/wyvern_dragonette-3_wavelengths.csv`;
  }
  return null;
}

/** The bundled fallback table for a sensor/band-count, or null when there is none. */
function bundledFor(sensor: string, bandCount: number): number[] | null {
  if (sensor === "DESIS" && bandCount === DESIS_WAVELENGTHS.length) return DESIS_WAVELENGTHS;
  if (sensor === "Wyvern" && bandCount === 23) return WYVERN_DRAGONETTE1;
  if (sensor === "Wyvern" && bandCount === 31) return WYVERN_DRAGONETTE3;
  return null;
}

/** Inputs for {@link resolveWavelengths}. */
export interface ResolveWavelengthsOptions {
  /** Sensor id ("DESIS" | "Wyvern" | "EnMAP" | "AVIRIS"). */
  sensor: string;
  /** Number of bands in the raster. */
  bandCount: number;
  /** Wavelengths read from the GeoTIFF's band tags, if any (preferred). */
  inFile?: number[] | null;
  /** Host hook to fetch a URL as bytes (skips the remote step when absent). */
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
}

/**
 * Resolve band center wavelengths for a GeoTIFF sensor, trying in-file tags, then
 * the remote CSV, then the bundled table, and finally band indices.
 *
 * @param opts - {@link ResolveWavelengthsOptions}.
 * @returns A wavelength array of length `bandCount`.
 */
export async function resolveWavelengths(
  opts: ResolveWavelengthsOptions,
): Promise<number[]> {
  const { sensor, bandCount, inFile, fetchArrayBuffer } = opts;

  if (inFile && inFile.length === bandCount && inFile.every(Number.isFinite)) {
    return inFile.map((w) => Math.round(w * 100) / 100);
  }

  const url = csvUrlFor(sensor, bandCount);
  if (url && fetchArrayBuffer) {
    try {
      const buf = await fetchArrayBuffer(url);
      const wl = parseWavelengthCsv(new TextDecoder().decode(buf));
      if (wl.length === bandCount) return wl;
    } catch {
      // fall through to the bundled table
    }
  }

  const bundled = bundledFor(sensor, bandCount);
  if (bundled) return bundled;

  // Last resort: 1..N band numbers so the scene still loads.
  return Array.from({ length: bandCount }, (_, i) => i + 1);
}
