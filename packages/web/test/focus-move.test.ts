// Keyboard scheme: plain arrows navigate focus between cards, Ctrl+arrows
// move the card (Left/Right across columns, Up/Down reorder). Moving remounts
// the card, so focus must follow through the optimistic remount and the async
// server-echo remount. Run via `bun run test:focus`.
import { afterAll, describe, expect, test } from "bun:test";
import { columnIds, focusedCardIn, initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/test123");

const board = {
  project: { id: "test123", title: "T" },
  todos: [
    { id: "t1", projectId: "test123", title: "one", status: "todo", rank: "5", updatedAt: 1 },
    { id: "t2", projectId: "test123", title: "two", status: "todo", rank: "6", updatedAt: 1 },
    { id: "t3", projectId: "test123", title: "three", status: "doing", rank: "5", updatedAt: 1 },
  ],
  rev: 7,
};

function key(target: HTMLElement, keyName: string, ctrl = false): void {
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: keyName, bubbles: true, ctrlKey: ctrl }),
  );
}

describe("keyboard arrows", () => {
  test("plain arrows navigate, ctrl+arrows move, focus follows", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();
    expect(columnIds(0)).toEqual(["t1", "t2"]);
    expect(columnIds(1)).toEqual(["t3"]);

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;

    // No focus yet: arrows enter the board at the first card. Dispatch on
    // the board itself: Solid delegates at the render root, so events outside
    // it never reach the handler.
    const boardEl = (): HTMLElement =>
      document.querySelector(".board") as HTMLElement;
    key(boardEl(), "ArrowDown");
    expect((await waitFor(1000, () => focusedCardIn("t1", 0)))?.dataset.todoId).toBe("t1");

    // Down/Up navigate within the column without moving anything.
    card("t1").focus();
    key(card("t1"), "ArrowDown");
    expect((await waitFor(1000, () => focusedCardIn("t2", 0)))?.dataset.todoId).toBe("t2");
    expect(columnIds(0)).toEqual(["t1", "t2"]);
    key(card("t2"), "ArrowUp");
    expect((await waitFor(1000, () => focusedCardIn("t1", 0)))?.dataset.todoId).toBe("t1");

    // Right/Left navigate across columns at the same position.
    key(card("t1"), "ArrowRight");
    expect((await waitFor(1000, () => focusedCardIn("t3", 1)))?.dataset.todoId).toBe("t3");
    expect(columnIds(0)).toEqual(["t1", "t2"]);
    expect(columnIds(1)).toEqual(["t3"]);
    key(card("t3"), "ArrowLeft");
    expect((await waitFor(1000, () => focusedCardIn("t1", 0)))?.dataset.todoId).toBe("t1");

    // Ctrl+Right moves across columns; focus follows through echo remount.
    key(card("t1"), "ArrowRight", true);
    expect((await waitFor(1500, () => focusedCardIn("t1", 1)))?.dataset.todoId).toBe("t1");
    expect(columnIds(0)).toEqual(["t2"]);
    expect(columnIds(1)).toEqual(["t1", "t3"]);

    // Ctrl+Down reorders within the column; focus follows.
    key(card("t1"), "ArrowDown", true);
    expect((await waitFor(1500, () => focusedCardIn("t1", 1)))?.dataset.todoId).toBe("t1");
    expect(columnIds(1)).toEqual(["t3", "t1"]);

    // Ctrl+Left moves back; same index clamps to the bottom.
    key(card("t1"), "ArrowLeft", true);
    expect((await waitFor(1500, () => focusedCardIn("t1", 0)))?.dataset.todoId).toBe("t1");
    expect(columnIds(0)).toEqual(["t2", "t1"]);

    // Escape blurs; arrows return to the last card.
    key(card("t1"), "Escape");
    expect(document.activeElement).toBe(document.body);
    key(document.querySelector(".board") as HTMLElement, "ArrowDown");
    expect((await waitFor(1000, () => focusedCardIn("t1", 0)))?.dataset.todoId).toBe("t1");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
