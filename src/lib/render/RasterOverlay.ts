/**
 * Renders an orthorectified RGB image on the GeoLibre map as a managed layer.
 *
 * The image is placed as a MapLibre `image` source + `raster` style layer, then
 * registered with the host via `registerExternalNativeLayer`. Registration is
 * what makes the layer appear in GeoLibre's Layers panel and on-map layer
 * control: the host adopts the existing style layer and drives its visibility,
 * opacity, and ordering. (A deck.gl overlay would render but stay invisible to
 * the panel, so the plain MapLibre layer is the right choice here.)
 *
 * The image is placed with [west, south, east, north] bounds in EPSG:4326. For
 * mid-latitude scenes (EMIT's coastal targets) the Web Mercator vs. lat/lon
 * corner placement is visually faithful.
 */

import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import type { Bounds } from "./orthorectify";
import type { GeoLibreNativeLayerRegistration } from "../geolibre/host-api";

/** Host hooks the overlay needs. */
export interface RasterOverlayDeps {
  getMap?: () => MapLibreMap | null;
  registerNativeLayer?: (layer: GeoLibreNativeLayerRegistration) => void;
  unregisterNativeLayer?: (id: string) => void;
}

/** Render RGBA bytes to a canvas (for the image-source data URL). */
function toCanvas(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to get a 2D canvas context.");
  const image = new ImageData(width, height);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export class RasterOverlay {
  private readonly _deps: RasterOverlayDeps;
  private readonly _id: string;
  private readonly _sourceId: string;
  private readonly _layerId: string;

  private _created = false;
  private _registeredName: string | null = null;

  /**
   * @param id - A stable, plugin-unique id used for the store layer and to
   *   namespace the map source/layer.
   * @param deps - Host hooks ({@link RasterOverlayDeps}).
   */
  constructor(id: string, deps: RasterOverlayDeps) {
    this._deps = deps;
    this._id = id;
    this._sourceId = `${id}-source`;
    this._layerId = `${id}-layer`;
  }

  /**
   * Show (or replace) the RGB image at the given geographic bounds.
   *
   * @param rgba - RGBA pixels, row-major (row 0 = north), length width*height*4.
   * @param width - Image width in pixels.
   * @param height - Image height in pixels.
   * @param bounds - Placement as [west, south, east, north], EPSG:4326.
   * @param name - Layer name shown in the host's Layers panel.
   */
  setImage(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    bounds: Bounds,
    name: string,
  ): void {
    const map = this._deps.getMap?.();
    if (!map) return;

    const [w, s, e, n] = bounds;
    // MapLibre image coordinates: top-left, top-right, bottom-right, bottom-left.
    const coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ] = [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ];
    const url = toCanvas(rgba, width, height).toDataURL("image/png");

    const existing = map.getSource(this._sourceId) as ImageSource | undefined;
    if (existing) {
      existing.updateImage({ url, coordinates });
    } else {
      map.addSource(this._sourceId, { type: "image", url, coordinates });
      map.addLayer({
        id: this._layerId,
        type: "raster",
        source: this._sourceId,
        paint: { "raster-opacity": 1, "raster-fade-duration": 0 },
      });
      this._created = true;
    }

    // Register (or refresh) so the layer shows in the host's panel. Re-register
    // only when the name changes; the host preserves user visibility/opacity.
    if (this._registeredName !== name) {
      this._deps.registerNativeLayer?.({
        id: this._id,
        name,
        type: "raster",
        nativeLayerIds: [this._layerId],
        sourceIds: [this._sourceId],
        sourceId: this._sourceId,
        opacity: 1,
        style: {},
      });
      this._registeredName = name;
    }
  }

  /** Remove the overlay from the map, the host store, and free resources. */
  remove(): void {
    // Unregistering triggers the host to remove the adopted layer + source.
    if (this._registeredName !== null) {
      try {
        this._deps.unregisterNativeLayer?.(this._id);
      } catch {
        // Ignore: the store record may already be gone.
      }
      this._registeredName = null;
    }

    // Defensively remove the raw layer/source too (e.g. standalone use with no
    // host registration, or if the host did not own teardown).
    const map = this._deps.getMap?.();
    if (map && this._created) {
      try {
        if (map.getLayer(this._layerId)) map.removeLayer(this._layerId);
        if (map.getSource(this._sourceId)) map.removeSource(this._sourceId);
      } catch {
        // Ignore: layer/source may already be gone.
      }
    }
    this._created = false;
  }
}
