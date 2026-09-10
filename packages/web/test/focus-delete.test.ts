// Delete key: a non-archived card goes straight to the top of archive;
// an archived card is permanently deleted, with focus moving to the next
// sibling (previous when last, nowhere when the column empties).
// Run via `bun run test:web`.
import { afterAll, describe, expect, test } from "bun:test";
import { columnIds, expandArchive, focusedCardIn, initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/del123");

const board = {
  project: { id: "del123", title: "D" },
  todos: [
    { id: "x1", projectId: "del123", title: "x", status: "todo", rank: "5", updatedAt: 1 },
    { id: "a1", projectId: "del123", title: "a", status: "archive", rank: "5", updatedAt: 1 },
    { id: "a2", projectId: "del123", title: "b", status: "archive", rank: "6", updatedAt: 1 },
  ],
  rev: 7,
};

function key(target: HTMLElement, keyName: string): void {
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: keyName, bubbles: true }),
  );
}

describe("delete key", () => {
  test("archive first, then permanent delete with focus handoff", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp(board);
    await settle();
    await expandArchive();
    expect(columnIds(0)).toEqual(["x1"]);
    expect(columnIds(3)).toEqual(["a1", "a2"]);

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;

    // HUD labels del by the focused card's state: x1 is still in todo.
    const hudHas = (s: string): boolean =>
      document.querySelector(".hud")?.textContent?.includes(s) ?? false;
    card("x1").focus();
    await waitFor(1000, () => (hudHas("archive") ? document.body : null));
    expect(hudHas("archive")).toBe(true);

    // Non-archived: straight to the top of archive, focus follows.
    key(card("x1"), "Delete");
    expect((await waitFor(1500, () => focusedCardIn("x1", 3)))?.dataset.todoId).toBe("x1");
    expect(columnIds(0)).toEqual([]);
    expect(columnIds(3)).toEqual(["x1", "a1", "a2"]);

    // ... and the label flips once x1 is archived.
    await waitFor(1000, () => (hudHas("delete") ? document.body : null));
    expect(hudHas("delete")).toBe(true);

    // Archived with a next sibling: gone, focus moves down.
    key(card("a1"), "Delete");
    expect((await waitFor(1500, () => focusedCardIn("a2", 3)))?.dataset.todoId).toBe("a2");
    expect(columnIds(3)).toEqual(["x1", "a2"]);

    // Archived last: gone, focus moves up (Backspace doubles as Delete).
    key(card("a2"), "Backspace");
    expect((await waitFor(1500, () => focusedCardIn("x1", 3)))?.dataset.todoId).toBe("x1");
    expect(columnIds(3)).toEqual(["x1"]);

    // Archived alone: gone, focus leaves to the body.
    key(card("x1"), "Delete");
    await waitFor(1000, () => (columnIds(3).length === 0 ? document.body : null));
    expect(columnIds(3)).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  test("held-key auto-repeat does not hard delete", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp({
      project: { id: "del123", title: "D" },
      todos: [
        { id: "h1", projectId: "del123", title: "hold", status: "todo", rank: "5", updatedAt: 1 },
      ],
      rev: 0,
    });
    await settle();
    await expandArchive();

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;
    card("h1").focus();
    key(card("h1"), "Delete");
    const archived = await waitFor(1500, () => focusedCardIn("h1", 3));
    expect(archived).toBeTruthy();

    // OS key repeat arrives as repeat:true with focus already on the archived
    // card; it must not escalate archive into permanent delete.
    archived!.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        repeat: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 200));

    expect(columnIds(3)).toEqual(["h1"]);
    const snap = await fetch("/api/projects/del123").then((r) => r.json());
    expect(snap.todos.some((t: { id: string }) => t.id === "h1")).toBe(true);
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
