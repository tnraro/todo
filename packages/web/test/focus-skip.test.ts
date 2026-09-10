// Horizontal navigation skips empty columns: with focus on a card, Left/Right
// lands on the next populated column at the same position, or stays put past
// the edges. Run via `bun run test:web`.
import { afterAll, describe, expect, test } from "bun:test";
import { columnIds, focusedCardIn, initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/skip123");

const board = {
  project: { id: "skip123", title: "S" },
  todos: [
    { id: "s1a", projectId: "skip123", title: "a", status: "todo", rank: "5", updatedAt: 1 },
    { id: "s1b", projectId: "skip123", title: "b", status: "todo", rank: "6", updatedAt: 1 },
    { id: "s2a", projectId: "skip123", title: "c", status: "done", rank: "5", updatedAt: 1 },
    { id: "s2b", projectId: "skip123", title: "d", status: "done", rank: "6", updatedAt: 1 },
    { id: "s2c", projectId: "skip123", title: "e", status: "done", rank: "7", updatedAt: 1 },
  ],
  rev: 7,
};

function key(target: HTMLElement, keyName: string): void {
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: keyName, bubbles: true }),
  );
}

describe("horizontal navigation skips empty columns", () => {
  test("right jumps the gap, left comes back, edges hold", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp(board);
    await settle();
    expect(columnIds(0)).toEqual(["s1a", "s1b"]);
    expect(columnIds(1)).toEqual([]);
    expect(columnIds(2)).toEqual(["s2a", "s2b", "s2c"]);

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;

    // Second card in todo -> same position in done, over empty doing.
    card("s1b").focus();
    key(card("s1b"), "ArrowRight");
    expect((await waitFor(1000, () => focusedCardIn("s2b", 2)))?.dataset.todoId).toBe("s2b");
    expect(columnIds(0)).toEqual(["s1a", "s1b"]);

    // Past the last populated column: focus stays.
    key(card("s2b"), "ArrowRight");
    await settle();
    expect(document.activeElement).toBe(card("s2b"));

    // Back over the gap to the same position.
    key(card("s2b"), "ArrowLeft");
    expect((await waitFor(1000, () => focusedCardIn("s1b", 0)))?.dataset.todoId).toBe("s1b");

    // Past the first populated column: focus stays.
    card("s1a").focus();
    key(card("s1a"), "ArrowLeft");
    await settle();
    expect(document.activeElement).toBe(card("s1a"));
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
