// Column hierarchy: doing stays bright, todo/done/archive are dim, and the
// archive rail starts collapsed with a persisted toggle. Run via `bun run test:web`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/col1");

const board = {
  project: { id: "col1", title: "C" },
  todos: [
    { id: "t1", projectId: "col1", title: "t", status: "todo", rank: "5", updatedAt: 1 },
    { id: "d1", projectId: "col1", title: "d", status: "doing", rank: "5", updatedAt: 1 },
    { id: "n1", projectId: "col1", title: "n", status: "done", rank: "5", updatedAt: 1 },
    { id: "a1", projectId: "col1", title: "a", status: "archive", rank: "5", updatedAt: 1 },
  ],
  rev: 0,
};

const columnAt = (i: number): HTMLElement =>
  document.querySelectorAll(".columns .column")[i] as HTMLElement;

describe("column hierarchy", () => {
  test("only doing is undimmed", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp(board);
    await settle();
    await settle();
    expect(columnAt(0).classList.contains("dim")).toBe(true);
    expect(columnAt(1).classList.contains("dim")).toBe(false);
    expect(columnAt(2).classList.contains("dim")).toBe(true);
    expect(columnAt(3).classList.contains("dim")).toBe(true);
    expect(document.querySelector('[data-todo-id="d1"]')).toBeTruthy();
  });

  test("archive is collapsed by default and toggles with persistence", async () => {
    localStorage.setItem("todo.archive-collapsed", "1");
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp(board);
    await settle();
    await settle();

    expect(document.querySelector(".columns.archive-collapsed")).toBeTruthy();
    expect(document.querySelector('[data-todo-id="a1"]')).toBeNull();
    expect(columnAt(3).classList.contains("collapsed")).toBe(true);
    expect(
      document.querySelector(".archive-toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");

    (document.querySelector(".archive-toggle") as HTMLElement).click();
    await waitFor(1000, () =>
      !document.querySelector(".columns.archive-collapsed")
        ? document.body
        : null,
    );
    expect(document.querySelector('[data-todo-id="a1"]')).toBeTruthy();
    expect(localStorage.getItem("todo.archive-collapsed")).toBe("0");

    (document.querySelector(".archive-toggle") as HTMLElement).click();
    await waitFor(1000, () =>
      document.querySelector(".columns.archive-collapsed")
        ? document.body
        : null,
    );
    expect(localStorage.getItem("todo.archive-collapsed")).toBe("1");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
