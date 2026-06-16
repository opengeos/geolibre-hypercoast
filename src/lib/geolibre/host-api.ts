/**
 * Canonical GeoLibre host-plugin contract.
 *
 * This module is the single source of truth for the interface between a plugin
 * and the GeoLibre host application. The GeoLibre wrapper in `src/geolibre.ts`
 * imports these types instead of redeclaring them, and downstream plugins built
 * from this template should do the same.
 *
 * The contract is intentionally free of MapLibre and React imports: a map
 * control is referenced only through the structural {@link GeoLibreControl}
 * type, so the same definitions describe both vanilla and React plugins. The
 * concrete control type is supplied as a generic parameter where it matters.
 */

// Type-only import: erased at build time, so it adds no MapLibre code to the
// bundle. The real GeoLibre host hands plugins a live `maplibre-gl` Map via
// `getMap`, so we type it accurately here.
import type { Map as MapLibreMap } from "maplibre-gl";

/** Corner of the map a control can be docked to. */
export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * File-type filter shown by the host's save/open dialog so plugins can label
 * exports (e.g. CSV) without knowing whether they run under Tauri or a browser.
 */
export interface GeoLibreFileDialogOptions {
  /** Human-readable file-type label, e.g. "Spectra" or "CSV". */
  description?: string;
  /** Allowed extensions without the leading dot, e.g. ["csv"]. */
  extensions?: string[];
  /** MIME type used for the browser download blob, e.g. "text/csv". */
  mimeType?: string;
}

/** Image payload a deck.gl `BitmapLayer` can render. */
export type GeoLibreBitmapImage =
  | ImageBitmap
  | ImageData
  | HTMLCanvasElement
  | HTMLImageElement
  | string;

/** Minimal structural props for a deck.gl `BitmapLayer` (only what we use). */
export interface GeoLibreBitmapLayerProps {
  id: string;
  image: GeoLibreBitmapImage;
  /** Geographic extent as [west, south, east, north] in EPSG:4326. */
  bounds: [number, number, number, number];
  opacity?: number;
  pickable?: boolean;
}

/** Opaque handle to a constructed deck.gl layer. */
export type GeoLibreDeckLayer = object;

/** Minimal structural handle to a deck.gl `MapboxOverlay` instance. */
export interface GeoLibreMapboxOverlay {
  setProps(props: { layers?: GeoLibreDeckLayer[] }): void;
  onAdd(map: unknown): HTMLElement;
  onRemove(): void;
  finalize?(): void;
}

/**
 * GeoLibre's own deck.gl modules, handed to a plugin via
 * {@link GeoLibreAppAPI.getDeckGL}. The plugin renders deck.gl layers on the
 * host's single deck.gl instance instead of bundling its own (deck.gl and
 * luma.gl throw on a version mismatch and share global singletons).
 *
 * The modules are typed loosely (no `@deck.gl/*` dependency in this template),
 * with precise constructor signatures only for the pieces this plugin uses.
 */
export interface GeoLibreDeckGL {
  core: Record<string, unknown>;
  layers: {
    BitmapLayer: new (props: GeoLibreBitmapLayerProps) => GeoLibreDeckLayer;
    [key: string]: unknown;
  };
  mapbox: {
    MapboxOverlay: new (props: {
      interleaved?: boolean;
      layers?: GeoLibreDeckLayer[];
    }) => GeoLibreMapboxOverlay;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Minimal GeoJSON `FeatureCollection` shape used when a plugin hands the host a
 * dataset to render as a native (MapLibre) layer. Kept structural so this
 * module does not depend on `geojson` types.
 */
export interface GeoLibreFeatureCollection {
  type: "FeatureCollection";
  features: unknown[];
}

/**
 * Visual styling hints for a native layer the host renders on the plugin's
 * behalf. Every field is optional; the host applies sensible defaults for any
 * value the plugin omits.
 */
export interface GeoLibreNativeLayerStyle {
  minZoom?: number;
  maxZoom?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  circleRadius?: number;
}

/**
 * Registration payload a plugin passes to
 * {@link GeoLibreAppAPI.registerExternalNativeLayer}. It lets GeoLibre own the
 * MapLibre sources and layers (so they appear in the host's layer panel and
 * respect its theme) while the plugin supplies the data and styling.
 */
export interface GeoLibreNativeLayerRegistration {
  /** Stable, plugin-unique id used later to unregister the layer. */
  id: string;
  /** Human-readable name shown in the host's layer list. */
  name: string;
  /**
   * Layer type, e.g. "geojson" or "raster". Drives how the host categorizes and
   * paints the adopted layer; defaults to "geojson" when omitted.
   */
  type?: string;
  /** Optional inline data; omit when the host already has the source. */
  geojson?: GeoLibreFeatureCollection;
  /**
   * MapLibre style-layer ids the host should adopt. The host applies visibility,
   * opacity, and ordering to exactly these ids, so the plugin must have already
   * created them with `map.addLayer` before registering.
   */
  nativeLayerIds: string[];
  /**
   * MapLibre source id(s) backing the layers above. Used by the host on teardown
   * to remove the plugin's sources, so provide the real ids to avoid leaks.
   */
  sourceIds: string[];
  /** Convenience single source id (equivalent to a one-element `sourceIds`). */
  sourceId?: string;
  /** Initial layer opacity in the range 0..1. */
  opacity: number;
  /** Styling hints applied to the rendered layer. */
  style: GeoLibreNativeLayerStyle;
  /** Arbitrary extra data the host may persist or display. */
  metadata?: Record<string, unknown>;
}

/**
 * Structural type for a MapLibre control instance. Using a marker interface
 * keeps this contract independent of the concrete control implementation while
 * still giving the host API a nominal-feeling handle to pass around.
 */
export interface GeoLibreControl {
  onAdd(...args: never[]): HTMLElement;
  onRemove(...args: never[]): void;
}

/**
 * The surface GeoLibre exposes to an active plugin.
 *
 * Only {@link addMapControl} and {@link removeMapControl} are guaranteed. The
 * remaining members are optional host capabilities: always call them with
 * optional chaining (`app.pickLocalDirectoryFiles?.()`) and degrade gracefully
 * when a host build does not provide them.
 *
 * @typeParam TControl - The plugin's concrete control type.
 */
export interface GeoLibreAppAPI<TControl extends GeoLibreControl = GeoLibreControl> {
  /**
   * Add the plugin's control to the map. Returns `false` when the host refuses
   * (for example, the slot is occupied), in which case the plugin should treat
   * activation as failed.
   */
  addMapControl: (
    control: TControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  /** Remove a previously added control from the map. */
  removeMapControl: (control: TControl) => void;
  /**
   * Open the host's native directory picker and resolve with the selected
   * files, or `null` if the user cancels. Present only on hosts that support
   * local file access (for example, GeoLibre Desktop).
   */
  pickLocalDirectoryFiles?: () => Promise<File[] | null>;
  /**
   * Resolve a fetchable URL for an asset bundled inside this plugin's own
   * folder, given the plugin id and a path relative to its manifest (for
   * example, `"dist/sample-data"`). Use this for assets the plugin ships and
   * loads over HTTP at runtime.
   *
   * Returns `null` when the plugin was not loaded from a URL base (for example,
   * a desktop filesystem install), so the asset is not reachable over HTTP. Call
   * with optional chaining and treat both `undefined` (host lacks the method)
   * and `null` (asset not resolvable) as "this asset is unavailable", hiding any
   * UI that depends on it.
   */
  resolvePluginAssetUrl?: (
    pluginId: string,
    relativePath: string,
  ) => string | null;
  /**
   * Hand the host a dataset to render as a native MapLibre layer it owns. See
   * {@link GeoLibreNativeLayerRegistration}.
   */
  registerExternalNativeLayer?: (
    layer: GeoLibreNativeLayerRegistration,
  ) => void;
  /** Remove a native layer previously registered with the given id. */
  unregisterExternalNativeLayer?: (id: string) => void;
  /**
   * Direct access to the host's live MapLibre map. Returns `null` before the
   * map is ready. Used here to register a deck.gl overlay and listen for map
   * clicks (the spectral inspector).
   */
  getMap?: () => MapLibreMap | null;
  /**
   * Resolve GeoLibre's own deck.gl modules so the plugin can render a
   * `BitmapLayer` (the RGB composite) on the host's single deck.gl instance.
   * Always call with optional chaining and fall back to a MapLibre `image`
   * source when absent. See {@link GeoLibreDeckGL}.
   */
  getDeckGL?: () => Promise<GeoLibreDeckGL>;
  /**
   * CORS-aware fetch returning raw bytes, used to load a hyperspectral scene
   * from a deep-link URL. The host proxies the request under Tauri.
   */
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  /**
   * Save text content to a file chosen by the user (a native save dialog under
   * Tauri, a browser download on the web). Used to export collected spectra to
   * CSV. Pass `options` to control the file-type label/extensions.
   */
  exportTextFile?: (
    filename: string,
    content: string,
    options?: GeoLibreFileDialogOptions,
  ) => void;
  /** Fit the map view to [west, south, east, north] in EPSG:4326. */
  fitBounds?: (bounds: [number, number, number, number]) => void;
}

/**
 * The object a plugin's GeoLibre entry point must export. GeoLibre calls these
 * members across the plugin lifecycle; everything beyond `id`, `name`,
 * `version`, `activate`, and `deactivate` is optional and only invoked when the
 * plugin declares it.
 *
 * @typeParam TControl - The plugin's concrete control type.
 */
export interface GeoLibrePlugin<TControl extends GeoLibreControl = GeoLibreControl> {
  /** Stable plugin id; must match `plugin.json`'s `id`. */
  id: string;
  /** Display name; must match `plugin.json`'s `name`. */
  name: string;
  /** Semantic version; must match `plugin.json`'s `version`. */
  version: string;
  /**
   * Query-parameter names this plugin owns. When the host opens a URL carrying
   * one of these, it auto-activates the plugin and routes the parameters to
   * {@link handleUrlParameters}.
   */
  urlParameterNames?: string[];
  /**
   * Activate the plugin: create and add the control. Return `false` (or remain
   * unactivated) if the control could not be added.
   */
  activate: (app: GeoLibreAppAPI<TControl>) => boolean | void;
  /**
   * Deactivate the plugin: capture any state to restore later, then remove the
   * control.
   */
  deactivate: (app: GeoLibreAppAPI<TControl>) => void;
  /**
   * Handle deep-link query parameters declared in {@link urlParameterNames}.
   * Dispatched by the host once the plugin is active. May be async.
   */
  handleUrlParameters?: (
    app: GeoLibreAppAPI<TControl>,
    params: URLSearchParams,
  ) => void | Promise<void>;
  /** Report the control's current dock position (for persistence). */
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  /** Move the control to a new dock position. */
  setMapControlPosition?: (
    app: GeoLibreAppAPI<TControl>,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  /** Serialize plugin state so the host can save it with the project. */
  getProjectState?: () => unknown;
  /** Restore plugin state previously produced by {@link getProjectState}. */
  applyProjectState?: (
    app: GeoLibreAppAPI<TControl>,
    state: unknown,
  ) => boolean | void;
}
