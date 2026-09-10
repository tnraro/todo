// Card context menu: touch holds and desktop right-clicks open the action
// sheet instead of the browser menu, wired to the same ops as the keyboard.
// Run via `bun run test:focus`.
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

describe("card context menu", () => {
  test("opens the sheet; actions move cards", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();
    await waitFor(2000, () =>
      columnIds(0).includes("h1") ? document.body : null,
    );
    expect(columnIds(0)).toEqual(["h1"]);

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;
    const sheetShown = () => document.querySelector(".sheet") as HTMLElement | null;
    const openMenu = (id: string, x = 100, y = 120) => {
      const event = new window.MouseEvent("contextmenu", {
        bubbles: true,
        clientX: x,
        clientY: y,
      });
      let defaultPrevented = false;
      const orig = event.preventDefault.bind(event);
      event.preventDefault = () => {
        defaultPrevented = true;
        orig();
      };
      card(id).dispatchEvent(event);
      return defaultPrevented;
    };

    // The browser menu is suppressed and the sheet opens.
    expect(openMenu("h1")).toBe(true);
    await waitFor(1000, () => sheetShown() ?? null);
    expect(sheetShown()).toBeTruthy();
    // happy-dom is 1024 wide: desktop dropdown anchored at the cursor.
    const sheet = sheetShown()!;
    expect(sheet.style.left).toBe("100px");
    expect(sheet.style.top).toBe("120px");

    // Off-screen cursors clamp into the viewport.
    expect(openMenu("h1", 2000, 2000)).toBe(true);
    await settle();
    const clamped = sheetShown()!;
    expect(parseInt(clamped.style.left)).toBeLessThan(2000);
    expect(parseInt(clamped.style.top)).toBeLessThan(2000);

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
    expect(openMenu("h2")).toBe(true);
    await waitFor(1000, () => sheetShown() ?? null);
    const labels = [...document.querySelectorAll(".sheet-item")].map(
      (el) => el.textContent,
    );
    expect(labels.some((t) => t?.includes("Delete"))).toBe(true);
    expect(labels.some((t) => t?.includes("Archive"))).toBe(false);

    // Scrim tap closes without side effects.
    (document.querySelector(".sheet-scrim") as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    await waitFor(1000, () => (!sheetShown() ? document.body : null));
    expect(sheetShown()).toBeNull();
    expect(columnIds(3)).toEqual(["h2"]);
  });

  test("the sheet owns the keyboard while open", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();
    await waitFor(2000, () =>
      columnIds(0).includes("h1") ? document.body : null,
    );

    const card = (id: string): HTMLElement =>
      document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement;
    const sheetShown = () =>
      document.querySelector(".sheet") as HTMLElement | null;
    card("h1").focus();
    card("h1").dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 120,
      }),
    );

    // Opening focuses the first action so Enter/Space and arrow keys work.
    const first = await waitFor(1000, () => {
      const el = document.activeElement as HTMLElement | null;
      return el?.classList.contains("sheet-item") ? el : null;
    });
    expect(first).toBeTruthy();

    const key = (keyName: string) =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new window.KeyboardEvent("keydown", { key: keyName, bubbles: true }),
      );

    // Board shortcuts must not reach the cards behind the scrim.
    key("n");
    await settle();
    expect(document.querySelector(".column .text-input")).toBeNull();
    key("Delete");
    await settle();
    expect(columnIds(0)).toEqual(["h1"]);
    expect(sheetShown()).toBeTruthy();

    // Arrows move between actions.
    key("ArrowDown");
    await settle();
    const items = [...document.querySelectorAll(".sheet-item")];
    expect(document.activeElement).toBe(items[1]);

    // Escape closes and returns focus to the card.
    key("Escape");
    await waitFor(1000, () => (!sheetShown() ? document.body : null));
    expect(sheetShown()).toBeNull();
    expect(document.activeElement).toBe(card("h1"));
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
