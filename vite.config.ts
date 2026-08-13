import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// M4 (src/lib/engine.ts): ship the Stockfish "lite-single" single-threaded Web Worker
// build as a plain public/ static asset instead of wiring it through Vite's JS/wasm
// asset pipeline. Two reasons:
//   1. The engine's own .js is a classic (non-module) Emscripten worker script that
//      locates its .wasm sibling via `location.pathname.replace(/\.js$/, ".wasm")` at
//      *worker* runtime — i.e. relative to wherever the worker script itself was
//      served from. A public/ copy served at `${BASE_URL}engine/...` satisfies that
//      unmodified under the GitHub Pages subpath base; no bundler URL-rewriting needed.
//   2. It sidesteps every "does new Worker(new URL(...)) survive minification /
//      the wasm asset getting hashed into a different directory" bundler footgun for a
///     7MB binary that's already a finished build artifact, not source to compile.
// Copying straight from the already-installed `stockfish` npm package on every
// dev/build start (idempotent, cheap) means public/engine/ never has to be hand-
// maintained or kept in sync manually.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ASSET_FILES = ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"];
const engineSrcDir = join(__dirname, "node_modules/stockfish/bin");
const engineDestDir = join(__dirname, "public/engine");
mkdirSync(engineDestDir, { recursive: true });
for (const file of ENGINE_ASSET_FILES) {
  const src = join(engineSrcDir, file);
  if (existsSync(src)) copyFileSync(src, join(engineDestDir, file));
}

export default defineConfig({
  // GitHub Pages serves the app under /<repo-name>/ — the deploy workflow sets
  // BASE_PATH; local dev and LAN preview stay at "/".
  base: process.env.BASE_PATH || "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Chess Opening Trainer",
        short_name: "Openings",
        description: "Drill chess openings with spaced repetition",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        display: "standalone",
        orientation: "portrait",
        // Relative to the manifest location so the same build works at "/" and
        // under the GitHub Pages subpath.
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // content JSON is fetched on demand and cached in IndexedDB by the app;
        // still let the SW cache it for offline resilience
        globPatterns: ["**/*.{js,css,html,png,svg,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        runtimeCaching: [
          {
            // Network-first so newly generated openings are picked up on launch;
            // long-term offline availability comes from IndexedDB, this SW cache
            // is only a fallback for content not yet in IndexedDB.
            urlPattern: /\/content\/.*\.json$/,
            handler: "NetworkFirst",
            options: { cacheName: "content-json", networkTimeoutSeconds: 4 }
          }
        ]
      }
    })
  ],
  server: { host: true }
});
