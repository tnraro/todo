import solid from "@solidjs/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // No virtual:pwa-register: the app registers manually in index.tsx
      // with the default SW lifecycle (updates on next navigation).
      // injectRegister:false keeps that manual call the single path.
      injectRegister: false,
      injectManifest: {
        // Manifest icons are precached automatically; keep the glob to build
        // outputs only.
        globPatterns: ["**/*.{js,css,html}"],
      },
      manifest: {
        name: "todo",
        short_name: "todo",
        description: "Anonymous kanban todo",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0f1115",
        theme_color: "#0f1115",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
