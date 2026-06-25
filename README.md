# zarr-viewer

Live: <https://tylere.github.io/zarr-viewer/>

Browser-only viewer for GeoZarr / Zarr raster datasets, built on MapLibre +
deck.gl + [`@developmentseed/deck.gl-zarr`](https://www.npmjs.com/package/@developmentseed/deck.gl-zarr).
Sibling of [`raster-viewer`](../raster-viewer) (which targets COGs) — both
build on [`@developmentseed/deck.gl-raster`](https://www.npmjs.com/package/@developmentseed/deck.gl-raster).

The viewer dispatches by **profile**: each dataset's specifics (metadata
override, dimension names, render path, selector UI, default rescale) live
in `src/zarr/profiles/<name>/`. Three profiles ship on `main`:

- **AEF** — `data.source.coop/tge-labs/aef-mosaic` (Zarr v3, GeoZarr-compliant, 64-band int8 embeddings; runtime RGB band picks)
- **FireSmoke** — `data.source.coop/alukach/firesmoke/forecasts.zarr` (BlueSky PM2.5 wildfire-smoke forecast; single-band + colormap)
- **FTW** — `data.source.coop/ftw/global-data/predictions/zarr/alpha/global.zarr` (Fields of The World global field-boundary predictions, float32; single-band + colormap)

The **ECMWF** profile lives on the
[`icechunk-support`](https://github.com/tylere/geozarr-viewer/tree/icechunk-support)
branch: its source
(`dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree`) is published only as
[Icechunk](https://icechunk.io/), which zarrita's `FetchStore` can't read, so
the profile is parked there pending Icechunk support.

## Development

```sh
pnpm install
pnpm dev
```

`pnpm test` runs the vitest suite; `pnpm build` runs `tsc` + Vite build.
