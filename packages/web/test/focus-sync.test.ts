// Offline outbox loop: mutations made while the backend is down stay queued
// (Syncing + pending count), then flush on reconnect and converge.
// Run via `bun run test:focus`.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "bun:test";
import { initDom, waitFor } from "./setup";

const window = initDom("http://localhost/p/sync1");

const board = {
  project: { id: "sync1", title: "S" },
  todos: [],
  rev: 0,
};

function setBackendOffline(offline: boolean): void {
  (globalThis as Record<string, unknown>).__backendOffline = offline;
}

function syncText(): string {
  return document.querySelector(".topbar-actions .sync-state")?.textContent ?? "";
}

describe("offline outbox", () => {
  test("queues while offline, flushes on reconnect", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp(board);
    await settle();
    // Boot now opens IndexedDB before fetching, so allow extra flushes.
    await waitFor(2000, () =>
      syncText().startsWith("Synced") ? document.body : null,
    );
    expect(syncText()).toBe("Synced");

    setBackendOffline(true);
    try {
      // Open the add row and submit a todo.
      (document.querySelector(".add-row") as HTMLElement).dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
      const input = await waitFor(1000, () => {
        const el = document.querySelector(
          ".column .text-input",
        ) as HTMLInputElement | null;
        return el && document.activeElement === el ? el : null;
      });
      expect(input).toBeTruthy();
      input!.value = "offline todo";
      input!.dispatchEvent(new window.Event("input", { bubbles: true }));
      // Solid 2.0 flushes writes async: a same-tick Enter would read a stale
      // draft (real keystrokes always cross task boundaries; this awaits one).
      await settle();
      input!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );

      // Optimistic card visible, op queued, status reflects the backlog.
      const card = await waitFor(1500, () =>
        document.querySelector('[data-todo-id]') ? document.body : null,
      );
      expect(card).toBeTruthy();
      await waitFor(1500, () =>
        syncText().includes("Syncing") ? document.body : null,
      );
      expect(syncText()).toMatch(/Syncing.*1/);
      // The server never saw it.
      const snap = await fetch("/api/projects/sync1").then((r) => r.json());
      expect(snap.todos).toEqual([]);
    } finally {
      setBackendOffline(false);
    }

    // Reconnect flushes; the card converges and the status clears.
    window.dispatchEvent(new window.Event("online"));
    await waitFor(2000, () =>
      syncText().startsWith("Synced") ? document.body : null,
    );
    expect(syncText()).toBe("Synced");
    const snap = await fetch("/api/projects/sync1").then((r) => r.json());
    expect(snap.todos.map((t: { title: string }) => t.title)).toEqual([
      "offline todo",
    ]);
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
