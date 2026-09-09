import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
