import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// Builds the DOM-test harness (Solid JSX needs the compiler; bun alone
// cannot transform it). Output is imported by the DOM test files.
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "dist-test",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "test/entry.tsx",
      formats: ["es"],
      fileName: () => "harness.js",
    },
  },
});
