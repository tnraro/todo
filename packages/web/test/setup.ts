// Shared DOM-test setup: one GlobalWindow per test file (a single Solid
// root per document, like the real app's full page loads), fetch/EventSource
// stubs via the harness bundle, and focus/column polling helpers.
import { GlobalWindow } from "happy-dom";

export function initDom(url: string): GlobalWindow {
  const window = new GlobalWindow({ url });
  (globalThis as Record<string, unknown>).window = window;
  // happy-dom v20 does not auto-register globals: expose the window's API
  // without clobbering bun natives.
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
  // happy-dom quirk (v20): `textContent = <number>` drops the value while
  // real browsers stringify it, which breaks Solid's text fast path on 0->n
  // transitions. Patch the double (every prototype with its own setter),
  // not the product.
  for (const proto of [window.Node.prototype, window.Element.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, "textContent");
    const set = desc?.set;
    if (desc && set) {
      Object.defineProperty(proto, "textContent", {
        ...desc,
        set(value: unknown) {
          set.call(this, typeof value === "number" ? String(value) : value);
        },
      });
    }
  }
  return window;
}

export const snapshot = {
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

export async function waitFor<T>(
  timeoutMs: number,
  get: () => T | null,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = get();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  return get();
}

/** The live edit input, when it holds focus. */
export function focusedEditInput(): HTMLInputElement | null {
  const el = document.querySelector(
    ".column-body .text-input",
  ) as HTMLInputElement | null;
  return el && document.activeElement === el ? el : null;
}

/** The live card with the id in the column, when it holds focus. */
export function focusedCardIn(id: string, column: number): HTMLElement | null {
  const cols = [...document.querySelectorAll(".columns .column")];
  const el = cols[column]?.querySelector(
    `[data-todo-id="${id}"]`,
  ) as HTMLElement | null;
  return el && document.activeElement === el ? el : null;
}

export function columnOf(el: HTMLElement): number {
  const cols = [...document.querySelectorAll(".columns .column")];
  return cols.findIndex((c) => c.contains(el));
}

export function columnIds(column: number): string[] {
  const cols = document.querySelectorAll(".columns .column");
  return [...(cols[column]?.querySelectorAll("[data-todo-id]") ?? [])].map(
    (el) => (el as HTMLElement).dataset.todoId!,
  );
}
