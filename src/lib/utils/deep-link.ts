/**
 * Deep-linking support for the GeoLibre integration: the HyperCoast plugin can
 * be opened with a hyperspectral scene preloaded by adding a query parameter to
 * the GeoLibre URL, e.g.
 * `https://geolibre.app/?hypercoast-data=https://example.com/EMIT_L2A_RFL.nc`.
 *
 * GeoLibre auto-activates a plugin when a URL carries a parameter the plugin
 * declared in `urlParameterNames`, then dispatches the parsed query parameters
 * to the plugin's `handleUrlParameters(app, params)` hook. These helpers operate
 * purely on a `URLSearchParams`, with no DOM or MapLibre imports, so the logic
 * can be unit-tested in isolation.
 */

/** Query-parameter name this plugin owns: a URL to a hyperspectral scene. */
export const PLUGIN_DATA_PARAM = "hypercoast-data";

/**
 * Extract the deep-link value from parsed query parameters. Returns the trimmed
 * value, or `null` when the parameter is absent or blank.
 */
export function getPluginDataValue(params: URLSearchParams): string | null {
  const trimmed = params.get(PLUGIN_DATA_PARAM)?.trim();
  return trimmed ? trimmed : null;
}

/** Minimal structural type for whatever consumes the deep-link value. */
export interface DeepLinkConsumer {
  loadFromUrl(value: string): Promise<void> | void;
}

/**
 * If the query parameters carry a {@link PLUGIN_DATA_PARAM} value, forward it to
 * the consumer. No-op when the parameter is absent or blank. Returns the
 * consumer's promise (if any) so callers can await completion.
 */
export async function maybeHandleDeepLink(
  consumer: DeepLinkConsumer,
  params: URLSearchParams,
): Promise<void> {
  const value = getPluginDataValue(params);
  if (value) await consumer.loadFromUrl(value);
}
