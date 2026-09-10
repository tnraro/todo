// Regression test: same-tick SSE batches must compose. Solid 2.0 stages
// writes, so sequential events must read the latest list and be flushed
// before the next event applies. Run via `bun run test:web`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { columnIds, initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/ev1");

describe("batched sse events", () => {
  test("two creates in one tick both land", async () => {
    const { mountApp, settle, FakeEventSource } = await import(
      "../dist-test/harness.js"
    );
    await mountApp({ project: { id: "ev1", title: "E" }, todos: [], rev: 7 });
    await settle();
    await settle();

    const src = FakeEventSource.instances.at(-1)!;
    src.emit({
      type: "todo:created",
      rev: 8,
      todo: { id: "a", projectId: "ev1", title: "A", status: "todo", rank: "5", updatedAt: 1 },
    });
    src.emit({
      type: "todo:created",
      rev: 9,
      todo: { id: "b", projectId: "ev1", title: "B", status: "todo", rank: "6", updatedAt: 2 },
    });

    await waitFor(1000, () => (columnIds(0).length === 2 ? document.body : null));
    expect(columnIds(0)).toEqual(["a", "b"]);
  });

  test("create, rename, and move in one tick compose on one card", async () => {
    const { mountApp, settle, FakeEventSource } = await import(
      "../dist-test/harness.js"
    );
    await mountApp({ project: { id: "ev2", title: "E2" }, todos: [], rev: 0 });
    await settle();
    await settle();

    const src = FakeEventSource.instances.at(-1)!;
    src.emit({
      type: "todo:created",
      rev: 1,
      todo: { id: "c", projectId: "ev2", title: "C", status: "todo", rank: "5", updatedAt: 1 },
    });
    src.emit({
      type: "todo:renamed",
      rev: 2,
      todo: { id: "c", projectId: "ev2", title: "C2", status: "todo", rank: "5", updatedAt: 2 },
    });
    src.emit({
      type: "todo:moved",
      rev: 3,
      todo: { id: "c", projectId: "ev2", title: "C2", status: "doing", rank: "5", updatedAt: 3 },
    });

    await waitFor(1000, () => (columnIds(1).length === 1 ? document.body : null));
    expect(columnIds(0)).toEqual([]);
    expect(columnIds(1)).toEqual(["c"]);
    expect(document.querySelector('[data-todo-id="c"]')?.textContent).toBe("C2");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
