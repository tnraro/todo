// Regression test for malformed percent-encoding in "/p/:id": the render used
// to throw URIError and leave a blank page. Run via `bun run test:web`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom } from "./setup";

const window = initDom("http://localhost/p/%");

describe("malformed project path", () => {
  test("does not crash the render", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp({ project: { id: "x", title: "x" }, todos: [], rev: 0 });
    await settle();
    expect(document.querySelector(".board")).toBeTruthy();
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
