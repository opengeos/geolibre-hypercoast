# GeoLibre HyperCoast

A [GeoLibre](https://github.com/opengeos/GeoLibre) plugin for visualizing and analyzing
hyperspectral remote-sensing data directly in the browser, inspired by the
[HyperCoast](https://hypercoast.org) QGIS plugin and Python package.

It brings HyperCoast's signature workflow to GeoLibre's web/desktop map:

- **Load a hyperspectral scene** from a local file — every sensor HyperCoast supports (EMIT, PACE,
  NEON, PRISMA, Tanager, AVIRIS, DESIS, EnMAP, Wyvern). The sensor is auto-detected from the file,
  with a manual override in the panel.
- **Build a wavelength-based RGB composite** with red/green/blue nanometre sliders (nearest-band
  selection) and an adjustable reflectance stretch.
- **Click any pixel to extract its full spectrum** across all bands, plotted as wavelength vs.
  reflectance. Multiple clicks accumulate as distinct series.
- **Export the collected spectra to CSV.**

Everything runs entirely client-side. HDF5/netCDF4 cubes are read with
[`h5wasm`](https://github.com/usnistgov/h5wasm) (a WebAssembly build of HDF5), GeoTIFFs with
[`geotiff.js`](https://github.com/geotiffjs/geotiff.js), and projected scenes are reprojected to
EPSG:4326 with [`proj4`](https://github.com/proj4js/proj4js). The plugin works in all three GeoLibre
runtimes (Tauri desktop, the web build, and the Jupyter widget) with no Python dependency.

## Supported data

| Sensor | Format | Geometry handling |
| ------ | ------ | ----------------- |
| NASA EMIT (L2A Reflectance) | netCDF4 (`.nc`) | GLT orthorectification |
| NASA PACE OCI (L2) | netCDF4 (`.nc`) | per-pixel lat/lon resampling |
| NEON AOP | HDF5 (`.h5`) | projected grid (UTM) |
| PRISMA (L2D) | HDF5-EOS (`.he5`) | projected grid (UTM) |
| Planet Tanager | HDF5 (`.h5`) | per-pixel lat/lon resampling |
| AVIRIS-3/5 | netCDF4 (`.nc`) | projected grid |
| DESIS | GeoTIFF (`.tif`) | projected grid |
| EnMAP | GeoTIFF (`.tif`) | projected grid |
| Wyvern (Dragonette) | GeoTIFF (`.tif`) | projected grid |

How each sensor is read mirrors HyperCoast's Python readers (`read_emit`, `read_pace`, `read_neon`,
`read_prisma`, `read_tanager`, `read_aviris`, `read_desis`, `read_enmap`, `read_wyvern`). EMIT and
PACE/Tanager arrive in swath geometry and are resampled to a regular EPSG:4326 grid; the others are
already gridded in a projected CRS and are placed by reprojecting their corners. For GeoTIFF sensors
whose wavelengths are not stored in the raster (DESIS, Wyvern), the band centers are fetched from the
same `opengeos/datasets` CSVs HyperCoast uses, with a bundled fallback so the plugin still works
offline.

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
2. Open the panel, leave **Sensor** on *Auto-detect* (or pick one), and click
   **Load hyperspectral scene…**, then choose a local `.nc` / `.h5` / `.he5` / `.tif` file.
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
