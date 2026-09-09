// Boot-from-cache: with the network snapshot hanging forever, the board
// must still render from IndexedDB. Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom } from "./setup";

const window = initDom("http://localhost/p/cache1");

describe("boot from cache", () => {
  test("renders cached project while the snapshot hangs", async () => {
    const { openLocalStore } = await import("../src/store");
    const seed = await openLocalStore();
    await seed.putProject({ id: "cache1", title: "Cached Title", lastRev: 5 });
    await seed.putTodos([
      { id: "c1", projectId: "cache1", title: "cached card", status: "todo", rank: "5", updatedAt: 1, pending: false },
    ]);
    seed.close();

    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(
      { project: { id: "cache1", title: "X" }, todos: [], rev: 0 },
      { hangSnapshot: true },
    );
    await settle();
    await settle();

    expect(document.querySelector(".topbar .project-title")?.textContent).toBe(
      "Cached Title",
    );
    expect(
      document.querySelector('[data-todo-id="c1"]')?.textContent,
    ).toBe("cached card");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
