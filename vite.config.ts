import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(() => ({
  // GitHub Pages serves from a `/geozarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  worker: { format: "es" as const },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
