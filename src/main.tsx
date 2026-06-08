import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { installConsoleAbortFilter } from "./zarr/tile-error";
import { installFloat16Polyfill } from "./zarr/float16-polyfill";

installFloat16Polyfill();
installConsoleAbortFilter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
