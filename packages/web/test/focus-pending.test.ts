import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom } from "./setup";

const window = initDom("http://localhost/p/pend1");

describe("pending reconciliation", () => {
  test("a stale pending flag clears on boot when no op is queued", async () => {
    const { openLocalStore } = await import("../src/store");
    const seed = await openLocalStore();
    await seed.putProject({ id: "pend1", title: "P1", lastRev: 0 });
    await seed.putTodos([
      { id: "p1", projectId: "pend1", title: "dimmed", status: "todo", rank: "5", updatedAt: 1, pending: true },
    ]);
    seed.close();

    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp({
      project: { id: "pend1", title: "P1" },
      todos: [
        { id: "p1", projectId: "pend1", title: "dimmed", status: "todo", rank: "5", updatedAt: 2 },
      ],
      rev: 1,
    });
    await settle();
    await settle();

    const card = document.querySelector('[data-todo-id="p1"]') as HTMLElement;
    expect(card.className).not.toContain("pending");
    const store = await openLocalStore();
    let persisted: boolean | undefined = true;
    const start = Date.now();
    while (persisted !== false && Date.now() - start < 3000) {
      persisted = (await store.getTodos("pend1"))[0]?.pending;
      if (persisted !== false) await new Promise((r) => setTimeout(r, 20));
    }
    expect(persisted).toBe(false);
    store.close();
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
