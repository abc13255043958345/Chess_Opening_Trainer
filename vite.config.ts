import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
