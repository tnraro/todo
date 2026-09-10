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
    expect(
      document
        .querySelector(".topbar-actions .sync-state")
        ?.getAttribute("role"),
    ).toBe("status");

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

  test("a 400 response converges the op instead of wedging the queue", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp({
      project: { id: "sync2", title: "S2" },
      todos: [
        { id: "q1", projectId: "sync2", title: "short", status: "todo", rank: "5", updatedAt: 1 },
      ],
      rev: 0,
    });
    await settle();
    await waitFor(2000, () => (syncText().startsWith("Synced") ? document.body : null));

    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (
      input: unknown,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PATCH") {
        return Response.json({ error: "title must be 1-200 chars" }, { status: 400 });
      }
      return realFetch(input, init);
    };

    const card = document.querySelector('[data-todo-id="q1"]') as HTMLElement;
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const edit = await waitFor(1000, () => {
      const el = document.querySelector(
        ".column-body .text-input",
      ) as HTMLInputElement | null;
      return el && document.activeElement === el ? el : null;
    });
    edit!.value = "renamed";
    edit!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    edit!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await waitFor(1500, () => (syncText().includes("Syncing") ? document.body : null));

    // Healthy backend again: the rejected op must not block later ops.
    (globalThis as Record<string, unknown>).fetch = realFetch;
    (document.querySelector(".add-row") as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    const add = await waitFor(1000, () => {
      const el = document.querySelector(
        ".column .text-input",
      ) as HTMLInputElement | null;
      return el && document.activeElement === el ? el : null;
    });
    add!.value = "after 400";
    add!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    add!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    await settle();
    await new Promise((r) => setTimeout(r, 300));
    const snap = await fetch("/api/projects/sync2").then((r) => r.json());
    expect(
      snap.todos.some((t: { title: string }) => t.title === "after 400"),
    ).toBe(true);
    // The rejected rename was dropped and the snapshot restored server truth.
    expect(snap.todos.find((t: { id: string }) => t.id === "q1")?.title).toBe(
      "short",
    );
  });

  test("overlong titles are clamped before they reach the server", async () => {
    const { mountApp, settle } = await import("../dist-focus/harness.js");
    await mountApp({
      project: { id: "sync3", title: "S3" },
      todos: [
        { id: "l1", projectId: "sync3", title: "short", status: "todo", rank: "5", updatedAt: 1 },
      ],
      rev: 0,
    });
    await settle();
    await waitFor(2000, () => (syncText().startsWith("Synced") ? document.body : null));

    const card = document.querySelector('[data-todo-id="l1"]') as HTMLElement;
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const edit = await waitFor(1000, () => {
      const el = document.querySelector(
        ".column-body .text-input",
      ) as HTMLInputElement | null;
      return el && document.activeElement === el ? el : null;
    });
    edit!.value = "x".repeat(300);
    edit!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    edit!.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    await settle();
    await new Promise((r) => setTimeout(r, 300));
    const snap = await fetch("/api/projects/sync3").then((r) => r.json());
    expect(snap.todos[0].title.length).toBe(200);
    expect(snap.todos[0].title).toBe("x".repeat(200));
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
