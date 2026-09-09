import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// Builds the DOM-test harness (Solid JSX needs the compiler; bun alone
// cannot transform it). Output is imported by test/focus.test.ts.
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "dist-focus",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "test/entry.tsx",
      formats: ["es"],
      fileName: () => "harness.js",
    },
  },
});
