export type Example = {
  title: string;
  url: string;
  /** Default URL params applied when the example is picked. Any param
   * already present in the current URL takes precedence over these
   * defaults (so a shared link with an explicit `?colormap=plasma`
   * isn't overwritten by the example's choice).
   *
   * Profiles are capability-based and default to `scalar-grid`; an example
   * that needs another profile sets `p` here (e.g. `p: "band-composite"`). */
  params?: Record<string, string>;
};

export const EXAMPLES: Example[] = [
  {
    title: "ECMWF IFS ENS — 2 m Temperature (forecast cube)",
    url: "https://source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr",
    // Europe-centered at zoom 4.5 — matches the upstream
    // `dynamical-zarr-ecmwf` example's default view, ECMWF's primary
    // forecast domain.
    params: { lng: "10", lat: "45", zoom: "4.5" },
  },
  {
    title: "AlphaEarth Foundations Mosaic (10 m, 64-band embeddings)",
    url: "https://data.source.coop/tge-labs/aef-mosaic",
    // 64-band int8 embeddings → RGB composite (not single-band colormap).
    params: { p: "band-composite" },
  },
  {
    title: "BlueSky FireSmoke PM2.5 forecast (Canada / North America)",
    url: "https://data.source.coop/alukach/firesmoke/forecasts.zarr",
    // BlueSky Canada covers most of North America. Centered on western
    // Canada at zoom 3, with a turbo colormap and a 0–100 µg/m³ range
    // that brackets typical wildfire-smoke severity.
    params: {
      lng: "-100",
      lat: "55",
      zoom: "3",
      colormap: "turbo",
      rescale: "0,100",
    },
  },
  {
    title: "Fields of The World — Global field-boundary predictions (alpha)",
    url: "https://data.source.coop/ftw/global-data/predictions/zarr/alpha/global.zarr",
    // ~10 m/px global; MIN_ZOOM is 12 so the example lands one level above
    // that. Iowa corn belt at zoom 13 puts you over visibly-distinct
    // agricultural fields. Defaults assume probability-style outputs.
    params: {
      lng: "-93.5",
      lat: "42.0",
      zoom: "13",
      colormap: "viridis",
      rescale: "0,1",
    },
  },
  // --- Icechunk stores read via the generic gridded profile (bkr/) ---
  // These are v1 Icechunk repos on the data.source.coop proxy; the generic
  // profile auto-enumerates variables and synthesizes the grid from the
  // latitude/longitude coord arrays. Most variables are float16 (handled by
  // the Float16Array polyfill).
  {
    title: "GFS — Global Forecast System (0.25°)",
    url: "https://source.coop/bkr/gfs/gfs.icechunk",
    // Global; defaults to the latest time of t2m. Longitude is 0–360 here;
    // the generic profile rolls it into the -180..180 frame.
    params: { lng: "0", lat: "20", zoom: "2", colormap: "turbo" },
  },
  {
    title: "GEOS — Composition Forecast (0.25°)",
    url: "https://source.coop/bkr/geos/geos_15min.icechunk",
    params: { lng: "0", lat: "20", zoom: "2", colormap: "viridis" },
  },
  {
    title: "SILAM — Aerosols & Dust (0.2°)",
    url: "https://source.coop/bkr/silam-dust/silam_aerosol.icechunk",
    // Defaults to PM25 over the latest init_time.
    params: { lng: "10", lat: "30", zoom: "2", colormap: "turbo" },
  },
  {
    title: "ICON — Global (unstructured mesh — not renderable)",
    url: "https://source.coop/bkr/icon/icon_global.icechunk",
    // ICON stores its fields on an unstructured triangular mesh (a `values`
    // dimension), not a regular lat/lon grid, so the generic raster profile
    // surfaces a clear "no gridded variables" message instead of rendering.
    params: { lng: "0", lat: "20", zoom: "2" },
  },
  // --- Additional Icechunk stores (generic profile) ---
  // Each verified to load and render through the generic profile by replaying
  // the prepare() path (normalizeStoreUrl → openV3Group → variable/grid
  // enumeration). Default views/variables are set from each store's actual
  // lat/lon extent and variable list.
  {
    title: "EEPS — Rain Rate / QPE (near-global)",
    url: "https://source.coop/bkr/err/eeps_cleaned.icechunk",
    // RRQPE on a regular lat/lon grid spanning 70°N–60°S. `var` lands on the
    // precip field instead of the alphabetically-first DQF quality flag.
    params: { lng: "0", lat: "10", zoom: "2", var: "RRQPE", colormap: "turbo" },
  },
  {
    title: "DWD ICON-EU — 2 m Temperature (5-day forecast)",
    url: "https://source.coop/dynamical/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk",
    // Regular lat/lon grid over Europe (29.5–70.5°N, -23.5–62.5°E). Lands on
    // temperature_2m (a preferred variable) at the first init_time/lead_time.
    params: { lng: "15", lat: "50", zoom: "4" },
  },
  {
    title: "CarbonPlan — Wildfire burn probability (CONUS)",
    url: "https://source.coop/carbonplan/carbonplan-ocr/output/fire-risk/tensor/production/v1.1.0/ocr.icechunk",
    // Very high-res CONUS lat/lon grid (22.4–52.5°N, -128.4–-64.1°E). Lands on
    // bp_2011 (annual burn probability); inferno reads well for fire risk.
    params: { lng: "-96", lat: "38", zoom: "4", colormap: "inferno" },
  },
  // These two repos are Icechunk but their names omit the `.icechunk` suffix;
  // they load via the layout probe in openV3Group (HEAD `<url>/repo`). Both are
  // E4DRR drought-monitoring stores on a regular lat/lon grid over East Africa.
  {
    title: "CHIRPS — Daily precipitation (East Africa)",
    url: "https://source.coop/e4drr-project/observations/chirps_daily_icechunk",
    // precip[time,lat,lon] over 14.4°S–25.5°N, 19.5–53.9°E; lands on the
    // earliest day. Single renderable variable (precip).
    params: { lng: "37", lat: "5", zoom: "4", colormap: "viridis" },
  },
  {
    title: "SEAS5 — SPI-3 drought index (East Africa, 10 km)",
    url: "https://source.coop/e4drr-project/forecasts/seas51_spi3_10km_icechunk_v2",
    // spi3[lead,member,init,lat,lon] over 12°S–23°N, 21–53°E. SPI is a signed
    // anomaly, so a diverging map (rdbu: red=dry, blue=wet) over ±2 reads well.
    params: { lng: "37", lat: "5", zoom: "4", colormap: "rdbu", rescale: "-2,2" },
  },
];
