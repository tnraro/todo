// Regression test for: "clicking a todo must focus its edit input".
// Simulates the browser sequence mousedown-focus + click.
// Run via `bun run test:focus` (builds the harness bundle first).
import { afterAll, describe, expect, test } from "bun:test";
import { columnOf, focusedEditInput, initDom, snapshot, waitFor } from "./setup";

const window = initDom("http://localhost/p/test123");

describe("todo click focuses edit input", () => {
  test("single click moves focus into the input", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(snapshot);
    await settle();

    const card = document.querySelector(
      '[data-todo-id="t1"]',
    ) as HTMLElement | null;
    expect(card).toBeTruthy();
    expect(columnOf(card!)).toBe(0);

    // Browser behavior: mousedown focuses the clicked card first.
    card!.focus();
    expect(document.activeElement).toBe(card);

    card!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const input = await waitFor(1000, focusedEditInput);
    expect(input?.tagName).toBe("INPUT");
    // The edit draft starts from the card title, ready to type over.
    expect(input?.value).toBe("hello");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
