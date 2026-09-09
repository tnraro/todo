// Regression test for: "clicking a todo must focus its edit input".
// Simulates the browser sequence mousedown-focus + click, then asserts the
// edit input holds focus. Run via `bun run test:focus` (needs the harness
// bundle built first).
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

const window = new GlobalWindow({ url: "http://localhost/p/test123" });

// happy-dom v20 does not auto-register globals: expose the window's API
// (document, constructors, rAF, …) without clobbering bun natives.
(globalThis as Record<string, unknown>).window = window;
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    try {
      (globalThis as Record<string, unknown>)[key] = (
        window as unknown as Record<string, unknown>
      )[key];
    } catch {
      // read-only globals stay as they are
    }
  }
}

const snapshot = {
  project: { id: "test123", title: "T" },
  todos: [
    {
      id: "t1",
      projectId: "test123",
      title: "hello",
      status: "todo",
      rank: "5",
      updatedAt: 1,
    },
  ],
  rev: 7,
};

async function activeInput(timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (document.activeElement?.tagName === "INPUT") return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return document.activeElement?.tagName === "INPUT";
}

describe("todo click focuses edit input", () => {
  test("single click moves focus into the input", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(snapshot);
    await settle();

    const card = document.querySelector(
      '[data-todo-id="t1"]',
    ) as HTMLElement | null;
    expect(card).toBeTruthy();

    // Browser behavior: mousedown focuses the clicked card first.
    card!.focus();
    expect(document.activeElement).toBe(card);

    card!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(await activeInput()).toBe(true);
    // The edit draft starts from the card title, ready to type over.
    expect((document.activeElement as HTMLInputElement).value).toBe("hello");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
