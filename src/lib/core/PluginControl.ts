import type {
  GeoJSONSource,
  IControl,
  Map as MapLibreMap,
  MapMouseEvent,
} from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type {
  PluginControlOptions,
  PluginState,
  HyperCoastState,
  PluginControlEvent,
  PluginControlEventHandler,
} from './types';
import type { DeepLinkConsumer } from '../utils/deep-link';
import type { SceneReader } from '../io/SceneReader';
import { nearestBandIndex } from '../io/SceneReader';
import { openEmitScene } from '../io/emit';
import { composeRgb } from '../render/orthorectify';
import { RasterOverlay } from '../render/RasterOverlay';
import { SpectrumChart, type ChartSeries } from '../chart/SpectrumChart';
import {
  spectraToCsv,
  spectrumColor,
  spectrumLabel,
  type CollectedSpectrum,
} from '../chart/spectra';

const OVERLAY_ID = 'hypercoast-rgb';
const POINTS_SOURCE = 'hypercoast-points-source';
const POINTS_LAYER = 'hypercoast-points-layer';

/** Default RGB wavelengths (nm) and reflectance stretch, matching HyperCoast. */
const DEFAULT_DATA: HyperCoastState = {
  rgb: { red: 650, green: 550, blue: 450 },
  stretch: { min: 0, max: 0.3 },
  inspectorActive: false,
  spectra: [],
};

/**
 * Default options for the PluginControl.
 *
 * Host-capability callbacks default to safe fallbacks so the control still works
 * as a standalone MapLibre control. The GeoLibre wrapper (`src/geolibre.ts`)
 * binds them to the real host APIs when the plugin runs inside GeoLibre.
 */
const DEFAULT_OPTIONS: Required<PluginControlOptions> = {
  collapsed: true,
  position: 'top-left',
  title: 'HyperCoast',
  panelWidth: 320,
  className: '',
  pickFiles: () => Promise.resolve(null),
  registerNativeLayer: () => undefined,
  unregisterNativeLayer: () => undefined,
  getMap: () => null,
  getDeckGL: undefined as unknown as Required<PluginControlOptions>['getDeckGL'],
  fetchArrayBuffer: (url: string) => fetch(url).then((r) => r.arrayBuffer()),
  exportTextFile: (filename, content, options) => downloadText(filename, content, options),
  fitBounds: undefined as unknown as Required<PluginControlOptions>['fitBounds'],
};

/**
 * Yield to the browser so it paints pending DOM updates before the next
 * (often main-thread-blocking) step. A double rAF guarantees a paint has
 * occurred, so the loading spinner/status is visible before heavy work begins.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Browser fallback for {@link PluginControlOptions.exportTextFile}. */
function downloadText(
  filename: string,
  content: string,
  options?: { mimeType?: string },
): void {
  const blob = new Blob([content], { type: options?.mimeType ?? 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Event handlers map type
 */
type EventHandlersMap = globalThis.Map<PluginControlEvent, Set<PluginControlEventHandler>>;

/** Mutable references to the panel's interactive elements. */
interface PanelRefs {
  loadStatus: HTMLElement;
  controls: HTMLElement;
  sceneInfo: HTMLElement;
  rgb: Record<'red' | 'green' | 'blue', { slider: HTMLInputElement; num: HTMLInputElement }>;
  stretch: { min: HTMLInputElement; max: HTMLInputElement };
  inspectorBtn: HTMLButtonElement;
  spectraInfo: HTMLElement;
  chart: HTMLElement;
}

/**
 * The HyperCoast map control: a toggle button and slide-out panel for
 * loading a hyperspectral scene, building a wavelength-based RGB composite, and
 * extracting per-pixel spectra by clicking the map.
 */
export class PluginControl implements IControl, DeepLinkConsumer {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _refs?: PanelRefs;
  private _options: Required<PluginControlOptions>;
  private _state: PluginState;
  private _eventHandlers: EventHandlersMap = new globalThis.Map();

  // Hyperspectral runtime state (not serialized).
  private _scene: SceneReader | null = null;
  private _overlay: RasterOverlay | null = null;
  private _chart: SpectrumChart | null = null;
  private _renderToken = 0;
  private _fitted = false;
  private _busy = false;

  // Map click handler for the spectral inspector.
  private _mapClickHandler: ((e: MapMouseEvent) => void) | null = null;

  // Panel positioning handlers
  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * Creates a new PluginControl instance.
   *
   * @param options - Configuration options for the control
   */
  constructor(options?: Partial<PluginControlOptions>) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._state = {
      collapsed: this._options.collapsed,
      panelWidth: this._options.panelWidth,
      data: { ...DEFAULT_DATA, rgb: { ...DEFAULT_DATA.rgb }, stretch: { ...DEFAULT_DATA.stretch }, spectra: [] },
    };
  }

  /**
   * Called when the control is added to the map.
   *
   * @param map - The MapLibre GL map instance
   * @returns The control's container element
   */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();

    // Append panel to map container for independent positioning.
    this._mapContainer.appendChild(this._panel);

    this._overlay = new RasterOverlay(OVERLAY_ID, {
      getMap: this._options.getMap,
      registerNativeLayer: this._options.registerNativeLayer,
      unregisterNativeLayer: this._options.unregisterNativeLayer,
    });

    this._setupEventListeners();

    if (!this._state.collapsed) {
      this._panel.classList.add('expanded');
      requestAnimationFrame(() => this._updatePanelPosition());
    }

    // Restore spectra/inspector from any applied project state.
    this._syncUiFromState();
    if (this._state.data.inspectorActive) this._setInspectorActive(true);

    return this._container;
  }

  /**
   * Called when the control is removed from the map.
   */
  onRemove(): void {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off('resize', this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener('click', this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }

    this._setInspectorActive(false);
    this._clearMarkers();
    this._chart?.dispose();
    this._chart = null;
    this._overlay?.remove();
    this._overlay = null;
    this._scene?.close();
    this._scene = null;

    this._panel?.parentNode?.removeChild(this._panel);
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._refs = undefined;
    this._eventHandlers.clear();
  }

  /**
   * Gets the current state of the control.
   *
   * @returns The current plugin state
   */
  getState(): PluginState {
    return { ...this._state };
  }

  /**
   * Updates the control state.
   *
   * @param newState - Partial state to merge with current state
   */
  setState(newState: Partial<PluginState>): void {
    this._state = { ...this._state, ...newState };
    this._emit('statechange');
  }

  /**
   * Toggles the collapsed state of the control panel.
   */
  toggle(): void {
    this._state.collapsed = !this._state.collapsed;

    if (this._panel) {
      if (this._state.collapsed) {
        this._panel.classList.remove('expanded');
        this._emit('collapse');
      } else {
        this._panel.classList.add('expanded');
        this._updatePanelPosition();
        this._emit('expand');
      }
    }

    this._emit('statechange');
  }

  /** Expands the control panel. */
  expand(): void {
    if (this._state.collapsed) this.toggle();
  }

  /** Collapses the control panel. */
  collapse(): void {
    if (!this._state.collapsed) this.toggle();
  }

  /**
   * Registers an event handler.
   *
   * @param event - The event type to listen for
   * @param handler - The callback function
   */
  on(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - The event type
   * @param handler - The callback function to remove
   */
  off(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Gets the map instance.
   *
   * @returns The MapLibre GL map instance or undefined if not added to a map
   */
  getMap(): MapLibreMap | undefined {
    return this._map;
  }

  /**
   * Gets the control container element.
   *
   * @returns The container element or undefined if not added to a map
   */
  getContainer(): HTMLElement | undefined {
    return this._container;
  }

  // -------------------------------------------------------------------------
  // Scene loading
  // -------------------------------------------------------------------------

  /**
   * Open a native file dialog and load the chosen EMIT `.nc` scene.
   *
   * Uses an `<input type="file">` rather than the host's directory picker
   * (`pickLocalDirectoryFiles`), so the user selects a single file. This works
   * in both the GeoLibre web build and the Tauri desktop webview.
   */
  async loadEmitFromFiles(): Promise<void> {
    const file = await this._openFileDialog();
    if (!file) {
      this._setLoadStatus('No file selected.');
      return;
    }
    this._setLoading(`Reading ${file.name}…`);
    await nextFrame();
    const bytes = await file.arrayBuffer();
    await this.loadSceneFromBytes(bytes, file.name);
  }

  /**
   * Prompt the user to choose a single `.nc` file.
   *
   * Resolves with the chosen file, or `null` if none was selected. Note that
   * browsers do not fire an event when the dialog is cancelled, so the promise
   * stays pending on cancel (the control simply stays idle).
   */
  private _openFileDialog(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.nc,.nc4';
      input.style.display = 'none';
      input.addEventListener(
        'change',
        () => {
          resolve(input.files?.[0] ?? null);
          input.remove();
        },
        { once: true },
      );
      document.body.appendChild(input);
      input.click();
    });
  }

  /**
   * Load a scene referenced by a deep-link URL (satisfies {@link DeepLinkConsumer}).
   *
   * @param value - A URL to an EMIT `.nc` scene.
   */
  async loadFromUrl(value: string): Promise<void> {
    this._setLoading(`Fetching ${value}…`);
    await nextFrame();
    let bytes: ArrayBuffer;
    try {
      bytes = await this._options.fetchArrayBuffer(value);
    } catch {
      this._setLoadStatus('Failed to fetch the scene URL.');
      return;
    }
    const name = value.split('/').pop() || value;
    await this.loadSceneFromBytes(bytes, name);
  }

  /**
   * Load a scene from raw `.nc` bytes: open it, populate the controls, render the
   * initial RGB composite, and fit the map to it.
   *
   * @param bytes - The complete EMIT `.nc` file contents.
   * @param name - A human-readable scene name.
   */
  async loadSceneFromBytes(bytes: ArrayBuffer, name: string): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    this._setLoading(`Loading ${name} into memory… (large scenes take a few seconds)`);
    await nextFrame();

    try {
      this._scene?.close();
      this._scene = null;
      this._fitted = false;
      this._clearSpectra();

      const scene = await openEmitScene(bytes, name);
      this._scene = scene;

      // Clamp the default/persisted RGB wavelengths to the scene's range.
      const wl = scene.metadata.wavelengths;
      const lo = wl[0];
      const hi = wl[wl.length - 1];
      const data = this._state.data;
      const clamp = (v: number) => Math.min(hi, Math.max(lo, v));
      this.setState({
        data: {
          ...data,
          sceneName: name,
          wavelengths: wl,
          rgb: { red: clamp(data.rgb.red), green: clamp(data.rgb.green), blue: clamp(data.rgb.blue) },
        },
      });

      this._configureWavelengthInputs(lo, hi);
      this._syncUiFromState();
      this._refs?.controls.classList.add('visible');
      this._setSceneInfo(
        `${name} - ${scene.metadata.bandCount} bands, ${wl[0].toFixed(0)}-${wl[wl.length - 1].toFixed(0)} nm`,
      );

      this._setLoading('Rendering RGB composite…');
      await nextFrame();
      await this._renderRgb();
      this._setLoadStatus('Scene loaded.');
    } catch (err) {
      this._scene?.close();
      this._scene = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._setLoadStatus(`Failed to load scene: ${msg}`);
    } finally {
      this._busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // RGB composite
  // -------------------------------------------------------------------------

  /** Read the selected RGB bands, compose them, and update the overlay. */
  private async _renderRgb(): Promise<void> {
    const scene = this._scene;
    const overlay = this._overlay;
    if (!scene || !overlay) return;

    const token = ++this._renderToken;
    const { rgb, stretch } = this._state.data;
    const wl = scene.metadata.wavelengths;

    try {
      const [r, g, b] = await Promise.all([
        scene.readOrthoBand(nearestBandIndex(wl, rgb.red)),
        scene.readOrthoBand(nearestBandIndex(wl, rgb.green)),
        scene.readOrthoBand(nearestBandIndex(wl, rgb.blue)),
      ]);
      if (token !== this._renderToken) return; // superseded by a newer request

      const rgba = composeRgb(r, g, b, stretch.min, stretch.max);
      const { width, height, bounds, name } = scene.metadata;
      overlay.setImage(rgba, width, height, bounds, name);

      if (!this._fitted) {
        this._fitted = true;
        this._fitBounds(bounds);
      }
    } catch {
      this._setLoadStatus('Failed to render the RGB composite.');
    }
  }

  /** Fit the map to the given bounds using the host hook or the map directly. */
  private _fitBounds(bounds: [number, number, number, number]): void {
    if (this._options.fitBounds) {
      this._options.fitBounds(bounds);
      return;
    }
    const map = this._options.getMap() ?? this._map ?? null;
    map?.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, duration: 600 },
    );
  }

  // -------------------------------------------------------------------------
  // Spectral inspector
  // -------------------------------------------------------------------------

  /** Turn the click-to-spectrum tool on or off. */
  private _setInspectorActive(active: boolean): void {
    const map = this._options.getMap() ?? this._map ?? null;
    this.setState({ data: { ...this._state.data, inspectorActive: active } });

    if (this._refs) {
      this._refs.inspectorBtn.classList.toggle('active', active);
      this._refs.inspectorBtn.textContent = active
        ? 'Spectral inspector: ON'
        : 'Spectral inspector: OFF';
    }

    if (!map) return;

    if (active && !this._mapClickHandler) {
      this._mapClickHandler = (e: MapMouseEvent) => void this._onMapClick(e);
      map.on('click', this._mapClickHandler);
      map.getCanvas().style.cursor = 'crosshair';
    } else if (!active && this._mapClickHandler) {
      map.off('click', this._mapClickHandler);
      this._mapClickHandler = null;
      map.getCanvas().style.cursor = '';
    }
  }

  /** Extract and store the spectrum at a clicked location. */
  private async _onMapClick(e: MapMouseEvent): Promise<void> {
    const scene = this._scene;
    if (!scene) return;
    const { lng, lat } = e.lngLat;

    let values: Float32Array | null;
    try {
      values = await scene.readSpectrumAt(lng, lat);
    } catch {
      this._setSpectraInfo('Failed to read spectrum.');
      return;
    }
    if (!values) {
      this._setSpectraInfo('No data at that location.');
      return;
    }

    const spectra = this._state.data.spectra;
    const color = spectrumColor(spectra.length);
    const spectrum: CollectedSpectrum = {
      id: `${Date.now()}-${spectra.length}`,
      lng,
      lat,
      values: Array.from(values),
      color,
    };
    this.setState({ data: { ...this._state.data, spectra: [...spectra, spectrum] } });

    this._renderMarkers();
    this._updateChart();
    this._setSpectraInfo(`${this._state.data.spectra.length} point(s) collected.`);
  }

  /**
   * Render collected-spectrum locations as a host-managed GeoJSON circle layer,
   * colored per point. Using the host map's own MapLibre instance (rather than a
   * bundled `Marker`) keeps MapLibre out of the plugin bundle.
   */
  private _renderMarkers(): void {
    const map = this._options.getMap() ?? this._map ?? null;
    if (!map) return;

    const data: FeatureCollection<Point, { color: string }> = {
      type: 'FeatureCollection',
      features: this._state.data.spectra.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { color: s.color },
      })),
    };

    const source = map.getSource(POINTS_SOURCE) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }

    map.addSource(POINTS_SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: POINTS_LAYER,
      type: 'circle',
      source: POINTS_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }

  /** Remove the spectrum-points layer and source from the map. */
  private _clearMarkers(): void {
    const map = this._options.getMap() ?? this._map ?? null;
    if (!map) return;
    try {
      if (map.getLayer(POINTS_LAYER)) map.removeLayer(POINTS_LAYER);
      if (map.getSource(POINTS_SOURCE)) map.removeSource(POINTS_SOURCE);
    } catch {
      // Ignore: layer/source may already be gone.
    }
  }

  /** Push the current spectra into the chart. */
  private _updateChart(): void {
    if (!this._chart) return;
    const wl = this._scene?.metadata.wavelengths ?? this._state.data.wavelengths;
    const spectra = this._state.data.spectra;
    if (!wl || spectra.length === 0) {
      this._chart.destroy();
      return;
    }
    const series: ChartSeries[] = spectra.map((s) => ({
      label: spectrumLabel(s),
      color: s.color,
      values: s.values,
    }));
    this._chart.setData(wl, series);
  }

  /** Export the collected spectra to a CSV file. */
  private _exportCsv(): void {
    const wl = this._scene?.metadata.wavelengths ?? this._state.data.wavelengths;
    const spectra = this._state.data.spectra;
    if (!wl || spectra.length === 0) {
      this._setSpectraInfo('No spectra to export.');
      return;
    }
    const csv = spectraToCsv(wl, spectra);
    const base = this._state.data.sceneName?.replace(/\.[^.]+$/, '') ?? 'hypercoast';
    this._options.exportTextFile(`${base}_spectra.csv`, csv, {
      description: 'Spectra',
      extensions: ['csv'],
      mimeType: 'text/csv',
    });
  }

  /** Clear all collected spectra, markers, and the chart. */
  private _clearSpectra(): void {
    this._clearMarkers();
    this.setState({ data: { ...this._state.data, spectra: [] } });
    this._chart?.destroy();
    this._setSpectraInfo('');
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

  private _setLoadStatus(message: string): void {
    if (!this._refs) return;
    this._refs.loadStatus.classList.remove('loading');
    this._refs.loadStatus.textContent = message;
  }

  /** Show an animated spinner with a status message during a load step. */
  private _setLoading(message: string): void {
    if (!this._refs) return;
    const el = this._refs.loadStatus;
    el.classList.add('loading');
    el.textContent = '';
    const spinner = document.createElement('span');
    spinner.className = 'hypercoast-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(spinner);
    el.appendChild(text);
  }

  private _setSceneInfo(message: string): void {
    if (this._refs) this._refs.sceneInfo.textContent = message;
  }

  private _setSpectraInfo(message: string): void {
    if (this._refs) this._refs.spectraInfo.textContent = message;
  }

  /** Set slider/number min/max to the scene's wavelength range. */
  private _configureWavelengthInputs(lo: number, hi: number): void {
    if (!this._refs) return;
    for (const key of ['red', 'green', 'blue'] as const) {
      const { slider, num } = this._refs.rgb[key];
      slider.min = String(Math.floor(lo));
      slider.max = String(Math.ceil(hi));
      num.min = slider.min;
      num.max = slider.max;
    }
  }

  /** Push current state values into the panel inputs. */
  private _syncUiFromState(): void {
    if (!this._refs) return;
    const { rgb, stretch, spectra } = this._state.data;
    this._refs.rgb.red.slider.value = String(rgb.red);
    this._refs.rgb.red.num.value = String(rgb.red);
    this._refs.rgb.green.slider.value = String(rgb.green);
    this._refs.rgb.green.num.value = String(rgb.green);
    this._refs.rgb.blue.slider.value = String(rgb.blue);
    this._refs.rgb.blue.num.value = String(rgb.blue);
    this._refs.stretch.min.value = String(stretch.min);
    this._refs.stretch.max.value = String(stretch.max);
    if (spectra.length > 0) {
      this._setSpectraInfo(`${spectra.length} point(s) collected.`);
      this._renderMarkers();
      this._updateChart();
    }
  }

  /**
   * Emits an event to all registered handlers.
   */
  private _emit(event: PluginControlEvent): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData = { type: event, state: this.getState() };
      handlers.forEach((handler) => handler(eventData));
    }
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  /**
   * Creates the main container element with the toggle button.
   */
  private _createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group plugin-control${
      this._options.className ? ` ${this._options.className}` : ''
    }`;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'plugin-control-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', this._options.title);
    // A spectrum-like icon: an upward wave over a baseline.
    toggleBtn.innerHTML = `
      <span class="plugin-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 17c2 0 3-9 5-9s2 6 4 6 3-9 5-9 2 5 4 5" />
          <line x1="3" y1="21" x2="21" y2="21" />
        </svg>
      </span>
    `;
    toggleBtn.addEventListener('click', () => this.toggle());

    container.appendChild(toggleBtn);
    return container;
  }

  /**
   * Creates the slide-out panel with the HyperCoast controls.
   */
  private _createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'plugin-control-panel hypercoast-panel';
    panel.style.width = `${this._options.panelWidth}px`;

    // Header
    const header = document.createElement('div');
    header.className = 'plugin-control-header';
    const title = document.createElement('span');
    title.className = 'plugin-control-title';
    title.textContent = this._options.title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'plugin-control-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.collapse());
    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'plugin-control-content';

    // Load button + status
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'plugin-control-button hypercoast-load';
    loadBtn.textContent = 'Load EMIT scene…';
    loadBtn.addEventListener('click', () => void this.loadEmitFromFiles());

    const loadStatus = document.createElement('div');
    loadStatus.className = 'plugin-control-status';

    const sceneInfo = document.createElement('div');
    sceneInfo.className = 'hypercoast-scene-info';

    // Scene-dependent controls (hidden until a scene loads)
    const controls = document.createElement('div');
    controls.className = 'hypercoast-controls';

    const rgbHeading = document.createElement('div');
    rgbHeading.className = 'plugin-control-label';
    rgbHeading.textContent = 'RGB composite (nm)';
    controls.appendChild(rgbHeading);

    const rgb = {
      red: this._createWavelengthRow('R', this._state.data.rgb.red, 'red', controls),
      green: this._createWavelengthRow('G', this._state.data.rgb.green, 'green', controls),
      blue: this._createWavelengthRow('B', this._state.data.rgb.blue, 'blue', controls),
    };

    // Stretch
    const stretchRow = document.createElement('div');
    stretchRow.className = 'plugin-control-group hypercoast-stretch';
    const stretchLabel = document.createElement('label');
    stretchLabel.className = 'plugin-control-label';
    stretchLabel.textContent = 'Reflectance stretch';
    const stretchInputs = document.createElement('div');
    stretchInputs.className = 'plugin-control-flex';
    const stretchMin = this._createNumberInput(this._state.data.stretch.min, 0, 1, 0.01);
    const stretchMax = this._createNumberInput(this._state.data.stretch.max, 0, 1, 0.01);
    const onStretch = () => {
      const min = parseFloat(stretchMin.value);
      const max = parseFloat(stretchMax.value);
      this.setState({ data: { ...this._state.data, stretch: { min, max } } });
      void this._renderRgb();
    };
    stretchMin.addEventListener('change', onStretch);
    stretchMax.addEventListener('change', onStretch);
    stretchInputs.appendChild(stretchMin);
    stretchInputs.appendChild(stretchMax);
    stretchRow.appendChild(stretchLabel);
    stretchRow.appendChild(stretchInputs);
    controls.appendChild(stretchRow);

    const divider = document.createElement('div');
    divider.className = 'plugin-control-divider';
    controls.appendChild(divider);

    // Spectral inspector
    const inspectorBtn = document.createElement('button');
    inspectorBtn.type = 'button';
    inspectorBtn.className = 'plugin-control-button hypercoast-inspector';
    inspectorBtn.textContent = 'Spectral inspector: OFF';
    inspectorBtn.addEventListener('click', () =>
      this._setInspectorActive(!this._state.data.inspectorActive),
    );
    controls.appendChild(inspectorBtn);

    const hint = document.createElement('div');
    hint.className = 'hypercoast-hint';
    hint.textContent = 'Turn on, then click the image to plot a pixel spectrum.';
    controls.appendChild(hint);

    const chart = document.createElement('div');
    chart.className = 'hypercoast-chart';
    controls.appendChild(chart);

    const spectraInfo = document.createElement('div');
    spectraInfo.className = 'plugin-control-status';
    controls.appendChild(spectraInfo);

    const spectraActions = document.createElement('div');
    spectraActions.className = 'plugin-control-flex';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'plugin-control-button hypercoast-secondary';
    exportBtn.textContent = 'Export CSV';
    exportBtn.addEventListener('click', () => this._exportCsv());
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'plugin-control-button hypercoast-secondary';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => this._clearSpectra());
    spectraActions.appendChild(exportBtn);
    spectraActions.appendChild(clearBtn);
    controls.appendChild(spectraActions);

    content.appendChild(loadBtn);
    content.appendChild(loadStatus);
    content.appendChild(sceneInfo);
    content.appendChild(controls);

    panel.appendChild(header);
    panel.appendChild(content);

    this._refs = {
      loadStatus,
      controls,
      sceneInfo,
      rgb,
      stretch: { min: stretchMin, max: stretchMax },
      inspectorBtn,
      spectraInfo,
      chart,
    };
    this._chart = new SpectrumChart(chart, 160);

    return panel;
  }

  /** Build one labeled wavelength slider + number input row. */
  private _createWavelengthRow(
    label: string,
    value: number,
    channel: 'red' | 'green' | 'blue',
    parent: HTMLElement,
  ): { slider: HTMLInputElement; num: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'hypercoast-wavelength-row';

    const tag = document.createElement('span');
    tag.className = `hypercoast-channel-tag ${channel}`;
    tag.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'hypercoast-slider';
    slider.min = '380';
    slider.max = '2500';
    slider.step = '1';
    slider.value = String(value);

    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'plugin-control-input hypercoast-wavelength-num';
    num.min = '380';
    num.max = '2500';
    num.step = '1';
    num.value = String(value);

    const apply = (v: number, render: boolean) => {
      slider.value = String(v);
      num.value = String(v);
      this.setState({
        data: { ...this._state.data, rgb: { ...this._state.data.rgb, [channel]: v } },
      });
      if (render) void this._renderRgb();
    };
    // Live label update while dragging; render on release/commit only.
    slider.addEventListener('input', () => {
      num.value = slider.value;
    });
    slider.addEventListener('change', () => apply(parseInt(slider.value, 10), true));
    num.addEventListener('change', () => apply(parseInt(num.value, 10), true));

    row.appendChild(tag);
    row.appendChild(slider);
    row.appendChild(num);
    parent.appendChild(row);

    return { slider, num };
  }

  /** Build a small numeric input for the stretch range. */
  private _createNumberInput(
    value: number,
    min: number,
    max: number,
    step: number,
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'plugin-control-input';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    return input;
  }

  // -------------------------------------------------------------------------
  // Panel positioning (unchanged from the template scaffold)
  // -------------------------------------------------------------------------

  private _setupEventListeners(): void {
    this._clickOutsideHandler = (e: MouseEvent) => {
      // Keep the panel open while the inspector is active so map clicks (which
      // land outside the panel) don't collapse it.
      if (this._state.data.inspectorActive) return;
      const target = e.target as Node;
      if (
        this._container &&
        this._panel &&
        !this._container.contains(target) &&
        !this._panel.contains(target)
      ) {
        this.collapse();
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);

    this._resizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    window.addEventListener('resize', this._resizeHandler);

    this._mapResizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    this._map?.on('resize', this._mapResizeHandler);
  }

  private _getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this._container?.parentElement;
    if (!parent) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';
    return 'top-right';
  }

  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;

    const button = this._container.querySelector('.plugin-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;

    const panelGap = 5;

    this._panel.style.top = '';
    this._panel.style.bottom = '';
    this._panel.style.left = '';
    this._panel.style.right = '';

    switch (position) {
      case 'top-left':
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case 'top-right':
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
      case 'bottom-left':
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case 'bottom-right':
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }
  }
}
