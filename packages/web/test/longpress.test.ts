// Touch long-press menu: a 500ms hold on a card opens an action sheet wired
// to the same ops as the keyboard. Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { columnIds, initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/hold1");

const board = {
  project: { id: "hold1", title: "H" },
  todos: [
    { id: "h1", projectId: "hold1", title: "one", status: "todo", rank: "5", updatedAt: 1 },
    { id: "h2", projectId: "hold1", title: "two", status: "archive", rank: "5", updatedAt: 1 },
  ],
  rev: 3,
};

function pointer(
  target: HTMLElement,
  type: string,
  pointerType: string,
): void {
  target.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, pointerType }),
  );
}

describe("long-press menu", () => {
  test("touch hold opens the sheet; actions move cards", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();
    expect(columnIds(0)).toEqual(["h1"]);

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;
    const sheetShown = () => document.querySelector(".sheet") as HTMLElement | null;

    // Mouse hold never opens the sheet.
    pointer(card("h1"), "pointerdown", "mouse");
    await new Promise((r) => setTimeout(r, 600));
    pointer(card("h1"), "pointerup", "mouse");
    expect(sheetShown()).toBeNull();

    // Quick touch tap never opens the sheet (and edits instead).
    pointer(card("h1"), "pointerdown", "touch");
    pointer(card("h1"), "pointerup", "touch");
    await settle();
    expect(sheetShown()).toBeNull();

    // 500ms touch hold opens it; the release click is swallowed (no editor).
    pointer(card("h1"), "pointerdown", "touch");
    await waitFor(1500, () => sheetShown() ?? null);
    expect(sheetShown()).toBeTruthy();
    pointer(card("h1"), "pointerup", "touch");
    card("h1").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(sheetShown()).toBeTruthy();
    expect(document.querySelector(".column-body .text-input")).toBeNull();

    // Move right one column (moves go adjacent, unlike focus skip).
    const right = [...document.querySelectorAll(".sheet-item")].find((el) =>
      el.textContent?.includes("→"),
    ) as HTMLElement;
    right.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(1500, () =>
      columnIds(1).includes("h1") && !sheetShown() ? document.body : null,
    );
    expect(columnIds(0)).toEqual([]);
    expect(columnIds(1)).toEqual(["h1"]);
    expect(sheetShown()).toBeNull();

    // Archived cards offer delete instead of archive.
    pointer(card("h2"), "pointerdown", "touch");
    await waitFor(1500, () => sheetShown() ?? null);
    const labels = [...document.querySelectorAll(".sheet-item")].map(
      (el) => el.textContent,
    );
    expect(labels.some((t) => t?.includes("Delete"))).toBe(true);
    expect(labels.some((t) => t?.includes("Archive"))).toBe(false);
    pointer(card("h2"), "pointerup", "touch");

    // Scrim tap closes without side effects.
    (document.querySelector(".sheet-scrim") as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    await waitFor(1000, () => (!sheetShown() ? document.body : null));
    expect(sheetShown()).toBeNull();
    expect(columnIds(3)).toEqual(["h2"]);
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
