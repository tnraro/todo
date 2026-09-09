// Static file serving: SPA fallback, hashed assets, and PWA root files.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/index";
import { openDb } from "../src/db";

const distDir = new URL("./fixtures/dist", import.meta.url).pathname;
const app = createApp(openDb(":memory:"), { distDir });

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), {} as never);
}

describe("static", () => {
  test("SPA fallback for / and /p/:id", async () => {
    for (const path of ["/", "/p/abc123"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('<div id="app">');
    }
  });

  test("PWA root files with correct content types", async () => {
    const sw = await get("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toContain("javascript");

    const manifest = await get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe(
      "application/manifest+json",
    );

    const icon = await get("/icon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("unknown paths and traversal 404", async () => {
    expect((await get("/nope.js")).status).toBe(404);
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/../package.json")).status).toBe(404);
  });

  test("missing dist disables static with a helpful API error", async () => {
    const bare = createApp(openDb(":memory:"), { distDir: null });
    const res = await bare.fetch(new Request("http://localhost/"), {} as never);
    expect(res.status).toBe(404);
  });
});
