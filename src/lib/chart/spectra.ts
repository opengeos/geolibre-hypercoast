/**
 * Data model and helpers for spectra collected by the spectral inspector.
 *
 * A {@link CollectedSpectrum} is one clicked pixel: its location plus the
 * per-band reflectance values. These are kept in plugin state (so they survive
 * deactivate/reactivate and project save), plotted by `SpectrumChart`, and
 * exported to CSV.
 */

/** One spectrum extracted at a clicked map location. */
export interface CollectedSpectrum {
  /** Stable unique id for this point. */
  id: string;
  /** Longitude in degrees. */
  lng: number;
  /** Latitude in degrees. */
  lat: number;
  /**
   * Per-band reflectance, aligned to the scene's wavelengths. May contain NaN
   * for unusable bands (these become `null`/gaps when plotted or exported).
   */
  values: number[];
  /** Plot/marker color (hex). */
  color: string;
}

/** Matplotlib "tab10" palette, matching HyperCoast's per-point cycling. */
export const SPECTRUM_PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
] as const;

/**
 * Pick a palette color for the nth collected point, cycling when exhausted.
 *
 * @param index - Zero-based point index.
 * @returns A hex color string.
 */
export function spectrumColor(index: number): string {
  return SPECTRUM_PALETTE[index % SPECTRUM_PALETTE.length];
}

/** Format a coordinate for CSV column headers and labels. */
function formatLngLat(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Human-readable label for a collected spectrum (lat, lon). */
export function spectrumLabel(s: CollectedSpectrum): string {
  return formatLngLat(s.lng, s.lat);
}

/**
 * Build a CSV with one row per band and one value column per collected point.
 *
 * Columns: `wavelength_nm`, then `point_N (lat, lon)` for each spectrum. NaN
 * values are written as empty cells.
 *
 * @param wavelengths - Band center wavelengths in nanometres.
 * @param spectra - Collected spectra (all aligned to `wavelengths`).
 * @returns CSV text with a trailing newline.
 */
export function spectraToCsv(
  wavelengths: readonly number[],
  spectra: readonly CollectedSpectrum[],
): string {
  const header = [
    "wavelength_nm",
    ...spectra.map((s, i) => `point_${i + 1} (${spectrumLabel(s)})`),
  ];
  const lines = [header.join(",")];

  for (let b = 0; b < wavelengths.length; b++) {
    const row = [String(wavelengths[b])];
    for (const s of spectra) {
      const v = s.values[b];
      row.push(v === undefined || Number.isNaN(v) ? "" : String(v));
    }
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}
