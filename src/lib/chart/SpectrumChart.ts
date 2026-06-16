/**
 * Thin uPlot wrapper for plotting reflectance spectra (wavelength vs. value).
 *
 * uPlot is a tiny, dependency-free canvas charting library that bundles cleanly
 * into the plugin's single ESM. Each collected spectrum becomes one line series
 * sharing the scene's wavelength axis. Axis/grid colors follow the host app's
 * theme to match the rest of the control.
 *
 * The chart sizes itself to its container via a `ResizeObserver`, so it tracks
 * the panel as the user resizes it. The container's height is layout-driven
 * (CSS flex), so the chart fills the space the panel gives it.
 */

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

/** One line series in the spectrum chart. */
export interface ChartSeries {
  /** Legend label (e.g. the point's coordinates). */
  label: string;
  /** Line color (hex). */
  color: string;
  /** Per-band values aligned to the shared wavelength axis; NaN renders as a gap. */
  values: number[];
}

/**
 * Pick theme-appropriate canvas colors for axes and grid, following the host
 * app's theme (GeoLibre toggles a `.dark` class on the document element) rather
 * than the OS preference.
 */
function themeColors(): { axis: string; grid: string } {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? { axis: "#cbd5e1", grid: "rgba(255, 255, 255, 0.12)" }
    : { axis: "#555555", grid: "rgba(0, 0, 0, 0.08)" };
}

export class SpectrumChart {
  private readonly _container: HTMLElement;
  private readonly _minHeight: number;
  private _plot: uPlot | null = null;
  private _observer: ResizeObserver | null = null;

  /**
   * @param container - Element the chart canvas mounts into and sizes to.
   * @param minHeight - Minimum chart height in pixels.
   */
  constructor(container: HTMLElement, minHeight = 160) {
    this._container = container;
    this._minHeight = minHeight;
    // Resize the plot to the container as the panel is resized.
    this._observer = new ResizeObserver(() => this._applySize());
    this._observer.observe(container);
  }

  /** Current plot size, derived from the container with sensible minimums. */
  private _size(): { width: number; height: number } {
    const width = Math.max(160, this._container.clientWidth || 280);
    const height = Math.max(this._minHeight, this._container.clientHeight || this._minHeight);
    return { width, height };
  }

  /** Resize the live plot to match the container. */
  private _applySize(): void {
    if (this._plot) this._plot.setSize(this._size());
  }

  /**
   * Replace the plotted data. Rebuilds the plot (series count changes as points
   * are added/removed), which is cheap for the handful of series involved.
   *
   * @param wavelengths - Shared x-axis values in nanometres.
   * @param series - One entry per collected spectrum.
   */
  setData(wavelengths: readonly number[], series: readonly ChartSeries[]): void {
    this.destroy();

    const colors = themeColors();
    const { width, height } = this._size();
    const xs = Float64Array.from(wavelengths);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) =>
        // uPlot renders null as a gap; map NaN (unusable bands) to null.
        Float64Array.from(s.values, (v) => (Number.isNaN(v) ? (null as unknown as number) : v)),
      ),
    ];

    const opts: uPlot.Options = {
      width,
      height,
      scales: { x: { time: false } },
      legend: { show: series.length > 0 && series.length <= 6 },
      cursor: { points: { size: 4 } },
      series: [
        { label: "nm" },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 1.5,
          points: { show: false },
        })),
      ],
      axes: [
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { stroke: colors.grid, width: 1 },
          font: "10px sans-serif",
        },
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { stroke: colors.grid, width: 1 },
          font: "10px sans-serif",
          size: 44,
        },
      ],
    };

    this._plot = new uPlot(opts, data, this._container);
  }

  /** Destroy the underlying uPlot instance and clear the container. */
  destroy(): void {
    if (this._plot) {
      this._plot.destroy();
      this._plot = null;
    }
    this._container.innerHTML = "";
  }

  /** Fully tear down the chart, including the resize observer. */
  dispose(): void {
    this.destroy();
    this._observer?.disconnect();
    this._observer = null;
  }
}
