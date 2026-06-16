import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  GeoLibreDeckGL,
  GeoLibreFileDialogOptions,
  GeoLibreNativeLayerRegistration,
} from '../geolibre/host-api';
import type { CollectedSpectrum } from '../chart/spectra';

/**
 * Options for configuring the PluginControl
 */
export interface PluginControlOptions {
  /**
   * Whether the control panel should start collapsed (showing only the toggle button)
   * @default true
   */
  collapsed?: boolean;

  /**
   * Position of the control on the map
   * @default 'top-right'
   */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  /**
   * Title displayed in the control header
   * @default 'Plugin Control'
   */
  title?: string;

  /**
   * Width of the control panel in pixels
   * @default 300
   */
  panelWidth?: number;

  /**
   * Custom CSS class name for the control container
   */
  className?: string;

  /**
   * Host-provided directory picker (for example, GeoLibre Desktop). Resolves
   * with the selected files, or `null` when the user cancels or no host picker
   * is available. The GeoLibre wrapper binds this to
   * `app.pickLocalDirectoryFiles`; defaults to a no-op returning `null`.
   */
  pickFiles?: () => Promise<File[] | null>;

  /**
   * Host callback to register a native MapLibre layer that GeoLibre owns and
   * renders on the plugin's behalf. Bound by the GeoLibre wrapper to
   * `app.registerExternalNativeLayer`; defaults to a no-op so the control also
   * works as a standalone MapLibre control.
   */
  registerNativeLayer?: (layer: GeoLibreNativeLayerRegistration) => void;

  /**
   * Host callback to remove a native layer previously registered with
   * {@link PluginControlOptions.registerNativeLayer}. Bound by the GeoLibre
   * wrapper to `app.unregisterExternalNativeLayer`; defaults to a no-op.
   */
  unregisterNativeLayer?: (id: string) => void;

  /**
   * Access the host's live MapLibre map. Bound by the GeoLibre wrapper to
   * `app.getMap`; used to render the raster overlay and listen for map clicks.
   */
  getMap?: () => MapLibreMap | null;

  /**
   * Resolve the host's deck.gl modules for rendering the RGB composite as a
   * `BitmapLayer`. Bound to `app.getDeckGL`; the overlay falls back to a
   * MapLibre image source when this is absent.
   */
  getDeckGL?: () => Promise<GeoLibreDeckGL>;

  /**
   * CORS-aware fetch returning raw bytes, used to load a scene from a deep-link
   * URL. Bound to `app.fetchArrayBuffer`; defaults to the global `fetch`.
   */
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;

  /**
   * Save text content to a user-chosen file (used for CSV export). Bound to
   * `app.exportTextFile`; defaults to a browser download.
   */
  exportTextFile?: (
    filename: string,
    content: string,
    options?: GeoLibreFileDialogOptions,
  ) => void;

  /**
   * Fit the map view to [west, south, east, north]. Bound to `app.fitBounds`;
   * defaults to using the map's own `fitBounds` when available.
   */
  fitBounds?: (bounds: [number, number, number, number]) => void;
}

/** Selected red/green/blue wavelengths (nm) for the RGB composite. */
export interface RgbSelection {
  red: number;
  green: number;
  blue: number;
}

/** Reflectance display range mapped to 0..255. */
export interface StretchRange {
  min: number;
  max: number;
}

/**
 * Serializable HyperCoast state. Note the loaded scene itself (a multi-gigabyte
 * file) is held outside state and is not persisted; only the display settings
 * and collected spectra are saved with the project. `wavelengths` is kept so
 * persisted spectra can be re-plotted before a scene is reloaded.
 */
export interface HyperCoastState {
  /** Name of the loaded scene, if any. */
  sceneName?: string;
  /** Wavelength axis (nm) of the loaded scene, for plotting persisted spectra. */
  wavelengths?: number[];
  /** Selected RGB wavelengths. */
  rgb: RgbSelection;
  /** Reflectance stretch range. */
  stretch: StretchRange;
  /** Whether the spectral inspector is active. */
  inspectorActive: boolean;
  /** Spectra collected by clicking the map. */
  spectra: CollectedSpectrum[];
}

/**
 * Internal state of the plugin control
 */
export interface PluginState {
  /**
   * Whether the control panel is currently collapsed
   */
  collapsed: boolean;

  /**
   * Current panel width in pixels
   */
  panelWidth: number;

  /**
   * HyperCoast-specific state (display settings and collected spectra).
   */
  data: HyperCoastState;
}

/**
 * Props for the React wrapper component
 */
export interface PluginControlReactProps extends PluginControlOptions {
  /**
   * MapLibre GL map instance
   */
  map: MapLibreMap;

  /**
   * Callback fired when the control state changes
   */
  onStateChange?: (state: PluginState) => void;
}

/**
 * Event types emitted by the plugin control
 */
export type PluginControlEvent = 'collapse' | 'expand' | 'statechange';

/**
 * Event handler function type
 */
export type PluginControlEventHandler = (event: { type: PluginControlEvent; state: PluginState }) => void;
