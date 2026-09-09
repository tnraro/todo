// DOM-test harness entry. Bundled by vite.focus.config.ts and driven by
// test/focus.test.ts under happy-dom. Installs fetch/EventSource stubs so no
// network is needed.
import { render } from "@solidjs/web";
import { keyBetween } from "@todo/shared";
import App from "../src/App";

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {}
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

interface FakeTodo {
  id: string;
  projectId: string;
  title: string;
  status: string;
  rank: string;
  updatedAt: number;
}

interface FakeSnapshot {
  project: { id: string; title: string };
  todos: FakeTodo[];
  rev: number;
}

/** Minimal in-memory backend: applies creates/renames/moves with rev bumps,
// echoing what the real server returns. Rank resolution mirrors the server
// (explicit neighbors win, both-open means top) using the shared keyBetween,
// so echos preserve the requested order. */
function installBackend(
  snapshot: FakeSnapshot,
  options: { hangSnapshot?: boolean } = {},
): void {
  const store = new Map(snapshot.todos.map((t) => [t.id, { ...t }]));
  let project = { ...snapshot.project };
  let rev = snapshot.rev;

  const rankOf = (status: string, id: string, excludeId: string): string | null => {
    const t = store.get(id);
    return t && t.status === status && t.id !== excludeId ? t.rank : null;
  };

  const firstRankIn = (status: string, excludeId: string): string | null => {
    let first: string | null = null;
    for (const t of store.values()) {
      if (t.status !== status || t.id === excludeId) continue;
      if (first === null || t.rank < first) first = t.rank;
    }
    return first;
  };

  const resolveRank = (
    status: string,
    selfId: string,
    beforeId: unknown,
    afterId: unknown,
  ): string => {
    const neighbor = (n: unknown): string | null =>
      typeof n === "string" ? rankOf(status, n, selfId) : null;
    let before = neighbor(beforeId);
    let after = neighbor(afterId);
    if (before === null && after === null) {
      after = firstRankIn(status, selfId);
    }
    if (before !== null && after !== null && before >= after) after = null;
    return keyBetween(before, after);
  };

  (globalThis as Record<string, unknown>).fetch = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    // Test hook: simulate offline mutations (GETs keep working).
    if (
      (globalThis as Record<string, unknown>).__backendOffline &&
      method !== "GET"
    ) {
      throw new TypeError("offline");
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const todosRe = /\/api\/projects\/([^/]+)\/todos(?:\/([^/]+)(\/move)?)?$/;

    if (method === "GET" && /\/api\/projects\/[^/]+$/.test(url)) {
      if (options.hangSnapshot) await new Promise(() => {});
      const snap: FakeSnapshot = {
        project: { ...project },
        todos: [...store.values()].map((t) => ({ ...t })),
        rev,
      };
      return Response.json(snap);
    }
    if (method === "POST" && url.endsWith("/todos")) {
      const todo: FakeTodo = {
        id: String(body.id),
        projectId: project.id,
        title: String(body.title),
        status: "todo",
        rank: resolveRank("todo", String(body.id), body.beforeId, body.afterId),
        updatedAt: Date.now(),
      };
      store.set(todo.id, todo);
      rev += 1;
      return Response.json({ todo, rev });
    }
    const m = url.match(todosRe);
    if (m) {
      const todo = store.get(decodeURIComponent(m[2]));
      if (!todo) return Response.json({ error: "todo not found" }, { status: 404 });
      if (method === "DELETE") {
        if (todo.status !== "archive") {
          return Response.json({ error: "only archived todos can be deleted" }, { status: 409 });
        }
        store.delete(todo.id);
        rev += 1;
        return Response.json({ rev });
      }
      if (method === "PATCH") todo.title = String(body.title);
      if (m[3] === "/move") {
        todo.status = String(body.toStatus);
        todo.rank = resolveRank(todo.status, todo.id, body.beforeId, body.afterId);
      }
      todo.updatedAt = Date.now();
      rev += 1;
      return Response.json({ todo: { ...todo }, rev });
    }
    if (method === "PATCH" && /\/api\/projects\/[^/]+$/.test(url)) {
      project = { ...project, title: String(body.title) };
      rev += 1;
      return Response.json({ project: { ...project }, rev });
    }
    return Response.json({}, { status: 200 });
  };
}

let disposeRoot: (() => void) | undefined;

export async function mountApp(
  snapshot: FakeSnapshot,
  options: { hangSnapshot?: boolean } = {},
): Promise<void> {
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  installBackend(snapshot, options);
  // Unmount the previous root first: two live roots share one document and
  // both would answer the same bubbled events (the detached one crashes).
  disposeRoot?.();
  document.body.innerHTML = '<div id="app"></div>';
  disposeRoot = render(() => <App />, document.getElementById("app")!);
  // Twice: boot opens IndexedDB before the snapshot fetch, so one frame is
  // often not enough for the first paint.
  await settle();
  await settle();
}

/** Let Solid 2.0's microtask flush (and one frame) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16);
    raf(() => setTimeout(resolve, 0));
  });
}
