# GeoLibre HyperCoast

A [GeoLibre](https://github.com/opengeos/GeoLibre) plugin for visualizing and analyzing
hyperspectral remote-sensing data directly in the browser, inspired by the
[HyperCoast](https://hypercoast.org) QGIS plugin and Python package.

It brings HyperCoast's signature workflow to GeoLibre's web/desktop map:

- **Load a hyperspectral scene** from a local file (currently NASA **EMIT** L2A reflectance `.nc`).
- **Build a wavelength-based RGB composite** with red/green/blue nanometre sliders (nearest-band
  selection) and an adjustable reflectance stretch.
- **Click any pixel to extract its full spectrum** across all bands, plotted as wavelength vs.
  reflectance. Multiple clicks accumulate as distinct series.
- **Export the collected spectra to CSV.**

Everything runs entirely client-side. Hyperspectral cubes (netCDF4 / HDF5) are read in the browser
with [`h5wasm`](https://github.com/usnistgov/h5wasm) (a WebAssembly build of HDF5), so the plugin
works in all three GeoLibre runtimes (Tauri desktop, the web build, and the Jupyter widget) with no
Python dependency.

## Supported data

| Sensor | Status | Format |
| ------ | ------ | ------ |
| NASA EMIT (L2A Reflectance) | Supported | netCDF4 (`.nc`) |
| NASA PACE OCI | Planned | netCDF4 (`.nc`) |
| NEON / PRISMA / Tanager | Planned | HDF5 (`.h5` / `.he5`) |
| DESIS / EnMAP / Wyvern | Planned | GeoTIFF (`.tif`) |

EMIT is the first sensor because its Geometry Lookup Table (GLT) lets the plugin orthorectify the
swath to a regular EPSG:4326 grid deterministically and cheaply, and its `.nc` is an HDF5 container
(the same reader path PACE/NEON/PRISMA reuse).

## Development

```bash
npm install
npm run dev        # standalone control dev server
npm test           # unit tests (vitest)
npm run build      # build the npm library and the GeoLibre bundle
```

### Building and installing the GeoLibre bundle

```bash
npm run build:geolibre     # -> geolibre-plugin/dist/{index.js,style.css} (+ wasm asset)
npm run package:geolibre   # build + zip -> geolibre-plugin/geolibre-hypercoast-<version>.zip
npm run install:geolibre   # build + copy into GeoLibre Desktop's plugins folder
npm run serve:geolibre -- 8000   # serve the unpacked bundle with CORS for the web build
```

- **Desktop:** run `npm run install:geolibre`, then restart GeoLibre Desktop. The bundle is copied
  to the app-data plugins directory (Linux: `~/.local/share/org.geolibre.desktop/plugins/geolibre-hypercoast/`).
- **Web build:** run `npm run serve:geolibre -- 8000`, then add `http://localhost:8000/plugin.json`
  under GeoLibre → Settings → Plugins.

## Usage

1. Activate **GeoLibre HyperCoast** from the plugins menu; a control button appears on the map.
2. Open the panel and click **Load EMIT scene…**, then choose a local EMIT L2A `.nc` file.
3. The RGB composite renders on the map and the view zooms to it. Drag the R/G/B wavelength sliders
   to recombine bands, and adjust the stretch range to taste.
4. Toggle **Spectral inspector** and click pixels on the raster to plot their spectra. Use
   **Export CSV** to save the collected spectra, or **Clear** to reset.

You can also deep-link a scene by URL:
`https://geolibre.app/?hypercoast-data=https://example.com/EMIT_L2A_RFL.nc`

## Acknowledgements

This plugin replicates functionality from [HyperCoast](https://github.com/opengeos/HyperCoast) by
Bingqing Liu and Qiusheng Wu. It is scaffolded from the
[geolibre-plugin-template](https://github.com/opengeos/geolibre-plugin-template).

## License

MIT
