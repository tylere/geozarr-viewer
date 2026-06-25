import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * When icechunk-js is installed from a GitHub tarball the compiled dist/ is
 * absent (it is .gitignore'd in the source repo and not included in the
 * archive). Resolve the import to the TypeScript source entry so Rolldown
 * (Vite 8 / Oxc) can bundle it directly with native TS support — no esbuild
 * step required.
 *
 * Returns null when dist/ is already present (normal npm/registry install).
 */
function findIcechunkSourceEntry(): string | null {
  try {
    const pkgDir = dirname(_require.resolve("icechunk-js/package.json"));
    const pkg = JSON.parse(
      readFileSync(resolve(pkgDir, "package.json"), "utf8"),
    ) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };

    // Determine the declared main entry from exports / main / module fields.
    let mainEntry: string | undefined;
    const exp = pkg.exports;
    if (typeof exp === "string") {
      mainEntry = exp;
    } else if (exp !== null && typeof exp === "object") {
      const dot = (exp as Record<string, unknown>)["."];
      if (typeof dot === "string") {
        mainEntry = dot;
      } else if (dot !== null && typeof dot === "object") {
        const d = dot as Record<string, string>;
        mainEntry = d["import"] ?? d["default"] ?? d["browser"] ?? d["module"];
      }
    }
    mainEntry ??= pkg.module ?? pkg.main ?? "index.js";

    if (existsSync(resolve(pkgDir, mainEntry))) {
      return null; // dist is present — normal resolution applies
    }

    // dist/ absent — locate TypeScript source entry.
    const candidates = [
      "src/index.ts",
      "src/index.mts",
      "index.ts",
      "lib/index.ts",
    ];
    return candidates.map((f) => resolve(pkgDir, f)).find(existsSync) ?? null;
  } catch {
    return null;
  }
}

const icechunkSourceEntry = findIcechunkSourceEntry();

export default defineConfig(() => ({
  // GitHub Pages serves from a `/geozarr-viewer/` subpath; the Pages workflow
  // sets BASE_PATH accordingly. Root-served hosts (Vercel, local dev) leave it
  // unset and get `/`.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  ...(icechunkSourceEntry && {
    resolve: { alias: { "icechunk-js": icechunkSourceEntry } },
  }),
  worker: { format: "es" as const },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
