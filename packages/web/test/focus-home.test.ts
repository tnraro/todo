// Home create failure must surface an inline error instead of failing
// silently. Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom, waitFor } from "./setup";

const window = initDom("http://localhost/");

describe("home create", () => {
  test("a failed create shows an inline error", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp({ project: { id: "x", title: "x" }, todos: [], rev: 0 });
    await settle();

    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (
      input: unknown,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        return Response.json({ error: "nope" }, { status: 500 });
      }
      return realFetch(input, init);
    };

    (document.querySelector(".home .btn") as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    const error = await waitFor(1000, () =>
      document.querySelector(".home-error") ? document.body : null,
    );
    expect(error).toBeTruthy();
    expect(document.querySelector(".home-error")?.textContent).toBeTruthy();
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
