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
 * Pick theme-appropriate canvas colors for axes and grid by reading the host
 * theme's CSS custom properties off the chart container. These are defined in
 * `plugin-control.css` and switch with GeoLibre's `.dark` ancestor class, so the
 * canvas stays in sync with the rest of the themed control without duplicating
 * the palette in JS. Hardcoded fallbacks cover the case where the variables are
 * missing (e.g. the stylesheet did not load).
 *
 * @param container - The chart container the CSS variables inherit onto.
 */
function themeColors(container: HTMLElement): { axis: string; grid: string } {
  const style = getComputedStyle(container);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    axis: read("--pc-chart-axis", "#555555"),
    grid: read("--pc-chart-grid", "rgba(0, 0, 0, 0.08)"),
  };
}

export class SpectrumChart {
  private readonly _container: HTMLElement;
  private readonly _minHeight: number;
  private _plot: uPlot | null = null;
  private _observer: ResizeObserver | null = null;
  private _themeObserver: MutationObserver | null = null;
  // Last data passed to setData, retained so a host theme switch can re-render
  // the canvas (whose colors are baked in at draw time) with the new palette.
  private _wavelengths: readonly number[] | null = null;
  private _series: readonly ChartSeries[] | null = null;
  // Whether a `.dark` ancestor is currently present; used to ignore unrelated
  // class mutations and only re-render when the light/dark state actually flips.
  private _isDark: boolean;

  /**
   * @param container - Element the chart canvas mounts into and sizes to.
   * @param minHeight - Minimum chart height in pixels.
   */
  constructor(container: HTMLElement, minHeight = 160) {
    this._container = container;
    this._minHeight = minHeight;
    this._isDark = this._detectDark();
    // Resize the plot to the container as the panel is resized.
    this._observer = new ResizeObserver(() => this._applySize());
    this._observer.observe(container);
    // Re-render when the host toggles its theme. GeoLibre flips a `.dark` class
    // on an ancestor (typically <html> or <body>), so watch both for class
    // changes and rebuild the canvas when the light/dark state changes.
    this._themeObserver = new MutationObserver(() => this._onThemeMutation());
    const opts: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["class"],
    };
    this._themeObserver.observe(document.documentElement, opts);
    if (document.body) this._themeObserver.observe(document.body, opts);
  }

  /** True when a `.dark` ancestor governs the container (matches the CSS). */
  private _detectDark(): boolean {
    return this._container.closest(".dark") !== null;
  }

  /** Rebuild the canvas with fresh colors when the host theme flips. */
  private _onThemeMutation(): void {
    const dark = this._detectDark();
    if (dark === this._isDark) return;
    this._isDark = dark;
    if (this._wavelengths && this._series) {
      this._render(this._wavelengths, this._series);
    }
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
    this._wavelengths = wavelengths;
    this._series = series;
    this._render(wavelengths, series);
  }

  /** Build the uPlot instance from data and the current host theme colors. */
  private _render(wavelengths: readonly number[], series: readonly ChartSeries[]): void {
    this._teardown();

    // Refresh the dark-state baseline against the live (attached) container so
    // the theme observer compares against what was actually rendered. At
    // construction the container may still be detached, so this is the reliable
    // point to capture it.
    this._isDark = this._detectDark();
    const colors = themeColors(this._container);
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

  /** Tear down the live uPlot instance and clear the container DOM. */
  private _teardown(): void {
    if (this._plot) {
      this._plot.destroy();
      this._plot = null;
    }
    this._container.innerHTML = "";
  }

  /**
   * Destroy the underlying uPlot instance and clear the container. Also forgets
   * the retained data so a subsequent host theme switch does not resurrect a
   * chart the caller intentionally cleared.
   */
  destroy(): void {
    this._teardown();
    this._wavelengths = null;
    this._series = null;
  }

  /** Fully tear down the chart, including the resize and theme observers. */
  dispose(): void {
    this.destroy();
    this._observer?.disconnect();
    this._observer = null;
    this._themeObserver?.disconnect();
    this._themeObserver = null;
  }
}
