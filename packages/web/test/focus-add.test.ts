// Add row termination policy: Enter on an empty input closes it, blur closes
// but keeps the draft, Escape discards. Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/add1");

const board = {
  project: { id: "add1", title: "A" },
  todos: [],
  rev: 0,
};

function focusedInput(): HTMLInputElement | null {
  const el = document.querySelector(
    ".column .text-input",
  ) as HTMLInputElement | null;
  return el && document.activeElement === el ? el : null;
}

function openAddRow(): void {
  (document.querySelector(".add-row") as HTMLElement).dispatchEvent(
    new window.MouseEvent("click", { bubbles: true }),
  );
}

describe("add row", () => {
  test("empty Enter closes, blur keeps the draft", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();

    openAddRow();
    const first = await waitFor(1000, focusedInput);
    expect(first).toBeTruthy();

    // Empty Enter cancels the add row instead of just clearing it.
    first!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await waitFor(1000, () =>
      !document.querySelector(".column .text-input") ? document.body : null,
    );
    expect(document.querySelector(".column .text-input")).toBeNull();

    // Typing then blurring closes the row but preserves the text.
    openAddRow();
    const second = await waitFor(1000, focusedInput);
    expect(second).toBeTruthy();
    second!.value = "kept draft";
    second!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    second!.blur();
    await waitFor(1000, () =>
      !document.querySelector(".column .text-input") ? document.body : null,
    );
    expect(document.querySelector(".column .text-input")).toBeNull();

    // Reopening restores the preserved draft.
    openAddRow();
    const third = await waitFor(1000, focusedInput);
    expect(third?.value).toBe("kept draft");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
