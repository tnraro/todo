// Forget: removes the local copy (IndexedDB rows + recent entry) while the
// server copy stays. Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom, waitFor } from "./setup";

const window = initDom("http://localhost/");

describe("forget", () => {
  test("drops the local copy from home recents", async () => {
    const { openLocalStore } = await import("../src/store");
    const seed = await openLocalStore();
    await seed.putProject({ id: "gone1", title: "Gone", lastRev: 3 });
    await seed.putTodos([
      { id: "g1", projectId: "gone1", title: "g", status: "todo", rank: "5", updatedAt: 1, pending: false },
    ]);
    seed.close();
    localStorage.setItem(
      "todo.recents",
      JSON.stringify([{ id: "gone1", title: "Gone" }]),
    );

    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp({ project: { id: "x", title: "x" }, todos: [], rev: 0 });
    await settle();

    expect(document.querySelector(".recent-row")).toBeTruthy();
    (document.querySelector(".recent-forget") as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    await waitFor(1000, () =>
      document.querySelector(".recent-row") ? null : document.body,
    );
    expect(document.querySelector(".recent-row")).toBeNull();
    expect(localStorage.getItem("todo.recents")).toBe("[]");

    const check = await openLocalStore();
    expect(await check.getProject("gone1")).toBeUndefined();
    expect(await check.getTodos("gone1")).toEqual([]);
    check.close();
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
