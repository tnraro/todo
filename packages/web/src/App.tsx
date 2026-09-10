// Single-view kanban board. No client router: "/" renders Home, "/p/:id"
// renders Board, navigations are real page loads. Server echo is truth;
// local writes are optimistic with rollback on failure.
import { For, Show, createEffect, createMemo, createSignal, flush, latest, onCleanup } from "solid-js";
import {
  PROJECT_TITLE_MAX,
  STATUSES,
  TODO_TITLE_MAX,
  keyBetween,
  type Project,
  type ServerEvent,
  type Status,
  type Todo,
} from "@todo/shared";
import {
  ApiError,
  createProject,
  fetchLog,
  fetchSnapshot,
  genTodoId,
  subscribe,
} from "./api";
import { collapseOps, sendOp } from "./sync";
import { locale, setLocale, t } from "./i18n";
import {
  openLocalStore,
  type LocalStore,
  type OutboxOp,
} from "./store";

/** Home path. A call (not a literal or const) so the compiler emits a runtime
 * setAttribute: a static `href=/` inlines into the template unquoted, which
 * some HTML parsers misread as an empty value. */
function homeHref(): string {
  return "/";
}

function byRank(a: Todo, b: Todo): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Focus an input mounted by a conditional branch. A ref callback can fire
 * before insertion, or its focus can be lost when the previously focused node
 * is removed by the same update. Waiting a frame with an isConnected guard
 * fixes both without ever stealing focus (unmounted inputs are skipped).
 */
function settleFocus(el: HTMLInputElement, selectAll = false): void {
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  });
}

// --- Recents (localStorage only; the server knows no users) -----------------
const RECENTS_KEY = "todo.recents";

function loadRecents(): { id: string; title: string }[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is { id: string; title: string } =>
        typeof r?.id === "string" && typeof r?.title === "string",
    );
  } catch {
    return [];
  }
}

function saveRecent(project: Project): void {
  try {
    const next = [
      { id: project.id, title: project.title },
      ...loadRecents().filter((r) => r.id !== project.id),
    ].slice(0, 10);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode etc: recents are a nicety, never load-bearing.
  }
}

function removeRecent(id: string): { id: string; title: string }[] {
  try {
    const next = loadRecents().filter((r) => r.id !== id);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

// --- Locale toggle ----------------------------------------------------------
function LocaleToggle() {
  return (
    <button
      class="locale-toggle"
      title={t().localeToggle.title}
      onClick={() => setLocale(locale() === "en" ? "ko" : "en")}
    >
      {t().localeToggle.label}
    </button>
  );
}

// --- Home -------------------------------------------------------------------
function Home() {
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [recents, setRecents] = createSignal(loadRecents());

  const create = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const clean =
        title().trim().slice(0, PROJECT_TITLE_MAX) || t().untitled;
      const project = await createProject(clean);
      location.href = `/p/${project.id}`;
    } catch {
      // Keep the draft; the button is the retry.
      setError(t().home.createFailed);
    } finally {
      setBusy(false);
    }
  };

  // Privacy: drop the local copy (IndexedDB rows + recent entry). The server
  // copy stays for everyone else with the link.
  const forget = (id: string) => {
    setRecents(removeRecent(id));
    void (async () => {
      try {
        const s = await openLocalStore();
        await s.clearProject(id);
        s.close();
      } catch {
        // Best effort; nothing user-visible depends on it.
      }
    })();
  };

  return (
    <div class="home">
      <h1>todo</h1>
      <div class="home-create">
        <input
          class="text-input"
          placeholder={t().home.titlePlaceholder}
          value={title()}
          maxlength={PROJECT_TITLE_MAX}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          ref={(el) => el.focus()}
        />
        <button class="btn" disabled={busy()} onClick={() => void create()}>
          {t().home.newProject}
        </button>
      </div>
      <Show when={error()}>
        {(msg) => <p class="home-error">{msg()}</p>}
      </Show>
      <Show when={recents().length > 0}>
        <div class="recents">
          <div class="recents-title">{t().home.recent}</div>
          <For each={recents()}>
            {(r) => (
              <div class="recent-row">
                <a class="recent-link" href={`/p/${r.id}`}>
                  {r.title || t().untitled}
                </a>
                <button
                  class="recent-forget"
                  title={t().home.forget}
                  onClick={() => forget(r.id)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="home-locale">
        <LocaleToggle />
      </div>
    </div>
  );
}

// --- Board ------------------------------------------------------------------
type LoadState = "loading" | "ready" | "missing" | "failed";

function Board(props: { projectId: string }) {
  const pid = props.projectId;
  const [state, setState] = createSignal<LoadState>("loading");
  const [project, setProject] = createSignal<Project | null>(null);
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [conn, setConn] = createSignal<"live" | "reconnecting">("live");
  const [copied, setCopied] = createSignal(false);

  // Editing state lives outside row data so re-renders never eat keystrokes.
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [selectAll, setSelectAll] = createSignal(false);
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [adding, setAdding] = createSignal(false);
  const [addDraft, setAddDraft] = createSignal("");
  const [editingProjectTitle, setEditingProjectTitle] = createSignal(false);
  const [projectDraft, setProjectDraft] = createSignal("");
  const [pending, setPending] = createSignal<Record<string, true>>({});
  const [flashes, setFlashes] = createSignal<Record<string, number>>({});
  const [dropPos, setDropPos] = createSignal<{
    status: Status;
    beforeId: string | null;
    afterId: string | null;
  } | null>(null);
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [focusKind, setFocusKind] = createSignal<FocusKind>("idle");
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const focusedStatus = createMemo(
    () => todos().find((t) => t.id === focusedId())?.status ?? null,
  );

  let lastRev = 0;
  let pendingRemoteTitle: string | null = null;
  let lastCardId: string | null = null;

  // --- Sync engine state ----------------------------------------------------
  /** Local deletes by todo id. Suppresses only events at or below the
   * recorded rev (P0-1: server ids are reusable, so tombstones expire). */
  const tombstones = new Map<string, { rev: number }>();
  /** Consecutive 5xx before an op is dropped as poison (P0-3). */
  const MAX_OP_ATTEMPTS = 5;
  const [sync, setSync] = createSignal<{
    state: "synced" | "syncing" | "offline";
    pending: number;
  }>({ state: "syncing", pending: 0 });

  /** Pending flags mirror the outbox: no queued op means nothing is pending,
   * so a crash between dequeue and ack cannot strand a dimmed card. */
  async function pendingFromOutbox(): Promise<Record<string, true>> {
    if (!store) return {};
    const ops = await store.listOutbox(pid).catch(() => []);
    const pd: Record<string, true> = {};
    for (const op of ops) if (op.todoId) pd[op.todoId] = true;
    return pd;
  }

  const columns = createMemo(() => {
    const all = todos();
    const by = (s: Status) => all.filter((t) => t.status === s).sort(byRank);
    return {
      todo: by("todo"),
      doing: by("doing"),
      done: by("done"),
      archive: by("archive"),
    } as Record<Status, Todo[]>;
  });

  /** Merge server todos, preserving object identity for unchanged rows and
   * freezing the card under edit. Returns ids that visibly changed. */
  function mergeTodos(prev: Todo[], next: Todo[]): { list: Todo[]; changed: string[] } {
    const editing = editingId();
    const prevById = new Map(prev.map((t) => [t.id, t]));
    const changed: string[] = [];
    const list = next.map((t) => {
      const p = prevById.get(t.id);
      if (t.id === editing && p) return p;
      if (
        p &&
        p.title === t.title &&
        p.status === t.status &&
        p.rank === t.rank &&
        p.updatedAt === t.updatedAt
      ) {
        return p;
      }
      if (!p || p.title !== t.title || p.status !== t.status || p.rank !== t.rank) {
        changed.push(t.id);
      }
      return t;
    });
    return { list, changed };
  }

  function flash(ids: string[]): void {
    const visible = ids.filter((id) => !pending()[id]);
    if (visible.length === 0) return;
    const stamp = Date.now();
    setFlashes((f) => {
      const next = { ...f };
      for (const id of visible) next[id] = stamp;
      return next;
    });
    setTimeout(() => {
      setFlashes((f) => {
        const next = { ...f };
        for (const id of visible) if (next[id] === stamp) delete next[id];
        return next;
      });
    }, 650);
  }

  /**
   * Central todos writer. Row identity changes remount the card element, which
   * drops a focused card: keyboard moves (necessarily a new row in a possibly
   * different column), REST echos, and remote moves. When the update replaces
   * the focused card, restore focus to it next frame — but only when focus was
   * truly lost, never stealing it from wherever the user moved it.
   */
  function applyTodos(next: Todo[] | ((prev: Todo[]) => Todo[])): void {
    const active = document.activeElement as HTMLElement | null;
    const focusedId = active?.dataset?.todoId ?? null;
    // Solid 2.0 batches writes: plain reads see the staged (old) value within
    // one tick. Event batches (delta pull) must compose on the latest list.
    const prev = latest(todos);
    const list = typeof next === "function" ? next(prev) : next;
    if (focusedId === null) {
      setTodos(list);
      return;
    }
    const before = prev.find((t) => t.id === focusedId);
    const after = list.find((t) => t.id === focusedId);
    setTodos(list); // raw setter: this function IS the wrapper, do not recurse
    if (!before || !after || after === before) return;
    requestAnimationFrame(() => {
      // Restore only a truly lost focus: body, null, or a node detached by
      // the very remount we just did. Liveness is tested against the live
      // tree (document.contains), never the node's own flags. Anything live
      // holding focus keeps it — never steal from inputs.
      const cur = document.activeElement as HTMLElement | null;
      if (cur && cur !== document.body && document.contains(cur)) return;
      focusCard(focusedId);
    });
  }

  function applySnapshotTodos(next: Todo[]): void {
    const { list, changed } = mergeTodos(latest(todos), next);
    applyTodos(list);
    flash(changed);
  }

  async function refetch(): Promise<void> {
    try {
      const snap = await fetchSnapshot(pid);
      // A concurrent refetch (one per gap event) may resolve out of order;
      // never roll state back past revs already applied.
      if (snap.rev < lastRev) return;
      if (!editingProjectTitle()) {
        setProject(snap.project);
      } else {
        pendingRemoteTitle = snap.project.title;
      }
      lastRev = snap.rev;
      applySnapshotTodos(snap.todos);
      setPending(await pendingFromOutbox());
      // Snapshot is truth: tombstones for todos the server still has are stale.
      const alive = new Set(snap.todos.map((td) => td.id));
      for (const id of [...tombstones.keys()]) {
        if (alive.has(id)) {
          tombstones.delete(id);
          void store?.deleteTombstone(id).catch(() => {});
        }
      }
    } catch {
      // Keep showing the last known state; the reconnect bar stays up.
    }
  }

  /** Delta pull from the persisted server log. */
  async function pullDelta(): Promise<void> {
    if (!store) return;
    try {
      let since = lastRev;
      for (;;) {
        const res = await fetchLog(pid, since);
        if ("reset" in res) {
          await refetch();
          return;
        }
        if (res.events.length === 0) return;
        // One tick may hold many events; drain each before the next reads
        // the list so no update composes on a stale snapshot.
        for (const ev of res.events) {
          onEvent(ev);
          flush();
        }
        if (res.events.length < 500) return;
        since = res.events[res.events.length - 1].rev;
      }
    } catch {
      // Stay on current state; the live stream heals the gap when it can.
    }
  }

  function onEvent(event: ServerEvent): void {
    if (event.type === "reset") {
      void refetch();
      return;
    }
    if (event.rev <= lastRev) return; // own echo already applied, or duplicate
    if (event.rev !== lastRev + 1) {
      void refetch(); // gap: resync from truth
      return;
    }
    lastRev = event.rev;
    if (event.type === "project:renamed") {
      if (editingProjectTitle()) {
        pendingRemoteTitle = event.project.title;
      } else {
        setProject(event.project);
        saveRecent(event.project);
      }
      return;
    }
    if (event.type === "todo:deleted") {
      tombstones.set(event.todoId, { rev: event.rev });
      void store?.putTombstone({
        todoId: event.todoId,
        projectId: pid,
        rev: event.rev,
        deletedAt: Date.now(),
      }).catch(() => {});
      applyTodos(latest(todos).filter((t) => t.id !== event.todoId));
      return;
    }
    // Tombstone gate (P0-1): a delete suppresses only older-or-equal events,
    // so a resurrected id (server ids are reusable) still applies. A create
    // newer than the tombstone clears it.
    const tomb = tombstones.get(event.todo.id);
    if (tomb && event.rev <= tomb.rev) return;
    if (event.type === "todo:created") {
      tombstones.delete(event.todo.id);
      void store?.deleteTombstone(event.todo.id).catch(() => {});
    }
    const prev = latest(todos);
    const idx = prev.findIndex((t) => t.id === event.todo.id);
    const next =
      idx < 0
        ? [...prev, event.todo]
        : [...prev.slice(0, idx), event.todo, ...prev.slice(idx + 1)];
    const { list, changed } = mergeTodos(prev, next);
    applyTodos(list);
    flash(changed);
  }

  // --- Optimistic mutations -------------------------------------------------
  function markPending(id: string): void {
    setPending((p) => ({ ...p, [id]: true }));
  }

  function unmarkPending(id: string): void {
    setPending((p) => {
      if (!p[id]) return p;
      const next = { ...p };
      delete next[id];
      return next;
    });
  }

  // --- Sync engine ------------------------------------------------------------
  // Every mutation enqueues an op and flushes. Failures stay queued (offline
  // is a state, not an error); rollback happens only when an op is dropped
  // as poison or converged, followed by a pull to server truth.
  let flushing = false;

  function updateSyncStatus(): void {
    void (async () => {
      const queued = store
        ? await store.listOutbox(pid).catch(() => [])
        : [];
      const online =
        typeof navigator === "undefined" ? true : navigator.onLine !== false;
      if (!online) setSync({ state: "offline", pending: queued.length });
      else if (conn() === "reconnecting" || flushing || queued.length > 0) {
        setSync({ state: "syncing", pending: queued.length });
      } else setSync({ state: "synced", pending: 0 });
    })();
  }

  function enqueueAndFlush(
    op: Omit<OutboxOp, "seq" | "attempts" | "createdAt">,
    rollback: () => void,
  ): void {
    const s = store;
    if (!s) return;
    void (async () => {
      try {
        await s.enqueue(op);
      } catch {
        rollback();
        return;
      }
      updateSyncStatus();
      void flushOutbox();
    })();
  }

  async function flushOutbox(): Promise<void> {
    const s = store;
    if (!s || flushing) return;
    const run = async (): Promise<void> => {
      if (flushing) return;
      flushing = true;
      updateSyncStatus();
      try {
        for (;;) {
          const ops = await s.listOutbox(pid).catch(() => []);
          if (ops.length === 0) break;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            break;
          }
          let progressed = false;
          for (const { op, seqs } of collapseOps(ops)) {
            try {
              const res = await sendOp(op);
              await s.removeOps(seqs).catch(() => {});
              progressed = true;
              applyAck(op, res.rev, res.todo, res.project);
            } catch (e) {
              if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
                // Converged or permanently invalid. A 409 on delete means the
                // todo was remotely un-archived: drop only the delete and let
                // the surviving ops resend after the refetch (remote wins).
                if (e.status === 409 && op.kind === "delete" && op.seq !== undefined) {
                  await s.removeOps([op.seq]).catch(() => {});
                } else {
                  await s.removeOps(seqs).catch(() => {});
                  if (op.todoId) unmarkPending(op.todoId);
                }
                progressed = true;
                void refetch(); // truth, not just events: the op never applied
                break;
              }
              if (e instanceof ApiError && e.status >= 500) {
                const attempts = op.attempts + 1;
                if (attempts > MAX_OP_ATTEMPTS) {
                  await s.removeOps(seqs).catch(() => {});
                  if (op.todoId) unmarkPending(op.todoId);
                  void refetch();
                } else {
                  for (const seq of seqs) {
                    await s.setAttempts(seq, attempts).catch(() => {});
                  }
                }
              }
              break; // network error, 429, or retryable 5xx: stop, keep queued
            }
          }
          updateSyncStatus();
          if (!progressed) break;
        }
      } finally {
        flushing = false;
        updateSyncStatus();
      }
    };
    try {
      const locks = (
        navigator as Navigator & {
          locks?: { request: (name: string, fn: () => Promise<void>) => Promise<void> };
        }
      )?.locks;
      if (locks) await locks.request("todo-sync", run);
      else await run();
    } catch {
      if (!flushing) await run().catch(() => {});
    }
  }

  /** REST ack without state authority (P0-2): remove/unmark, apply the echo
   * only when it is exactly next, pull on a gap. */
  function applyAck(
    op: OutboxOp,
    rev: number,
    todo?: Todo,
    project?: Project,
  ): void {
    if (op.todoId) {
      if (op.kind === "delete") {
        const prev = tombstones.get(op.todoId);
        if (!prev || prev.rev < rev) {
          tombstones.set(op.todoId, { rev });
          void store
            ?.putTombstone({ todoId: op.todoId, projectId: pid, rev, deletedAt: Date.now() })
            .catch(() => {});
        }
      }
      unmarkPending(op.todoId);
    }
    if (rev <= lastRev) return;
    if (rev !== lastRev + 1) {
      void pullDelta();
      return;
    }
    lastRev = rev;
    if (todo) {
      const prev = latest(todos);
      const idx = prev.findIndex((t) => t.id === todo.id);
      const next =
        idx < 0
          ? [...prev, todo]
          : [...prev.slice(0, idx), todo, ...prev.slice(idx + 1)];
      const { list, changed } = mergeTodos(prev, next);
      applyTodos(list);
      flash(changed);
    } else if (project) {
      setProject(project);
      saveRecent(project);
    }
  }

  function handleCreate(title: string): void {
    const clean = title.trim().slice(0, TODO_TITLE_MAX);
    if (!clean) return;
    const id = genTodoId();
    const optimistic: Todo = {
      id,
      projectId: pid,
      title: clean,
      status: "todo",
      rank: "",
      updatedAt: 0,
    };
    applyTodos((prev) => [optimistic, ...prev]);
    markPending(id);
    enqueueAndFlush(
      { projectId: pid, kind: "create", todoId: id, title: clean },
      () => {
        applyTodos((prev) => prev.filter((t) => t.id !== id));
        unmarkPending(id);
      },
    );
  }

  function handleRename(id: string, title: string): void {
    const clean = title.trim().slice(0, TODO_TITLE_MAX);
    const prev = todos().find((t) => t.id === id);
    if (!prev || prev.title === clean || !clean) return;
    applyTodos((list) => list.map((t) => (t.id === id ? { ...t, title: clean } : t)));
    markPending(id);
    enqueueAndFlush(
      { projectId: pid, kind: "rename", todoId: id, title: clean },
      () => {
        applyTodos((list) => list.map((t) => (t.id === id ? prev : t)));
        unmarkPending(id);
      },
    );
  }

  function handleMove(
    id: string,
    toStatus: Status,
    beforeId: string | null,
    afterId: string | null,
  ): void {
    const prevList = todos();
    const moving = prevList.find((t) => t.id === id);
    if (!moving) return;
    const rest = prevList.filter((t) => t.id !== id);
    const target = rest.filter((t) => t.status === toStatus).sort(byRank);
    let idx: number;
    if (afterId) idx = target.findIndex((t) => t.id === afterId);
    else if (beforeId) idx = target.findIndex((t) => t.id === beforeId) + 1;
    else idx = 0;
    if (idx < 0) idx = beforeId ? target.length : 0;
    // Estimate the rank the server will assign so the optimistic card sorts
    // into place immediately; the echo overwrites with the authority.
    // Mirrors the server rule: unknown neighbors heal to open ends, and both
    // open ends mean the top of the column.
    const rankOf = (nid: string | null): string | null =>
      nid ? (target.find((t) => t.id === nid)?.rank ?? null) : null;
    const beforeRank = rankOf(beforeId);
    let afterRank = rankOf(afterId);
    if (beforeRank === null && afterRank === null) {
      afterRank = target[0]?.rank ?? null;
    }
    if (
      beforeRank !== null &&
      afterRank !== null &&
      beforeRank >= afterRank
    ) {
      afterRank = null;
    }
    const moved: Todo = {
      ...moving,
      status: toStatus,
      rank: keyBetween(beforeRank, afterRank),
    };
    const newTarget = [...target.slice(0, idx), moved, ...target.slice(idx)];
    applyTodos([...rest.filter((t) => t.status !== toStatus), ...newTarget]);
    markPending(id);
    enqueueAndFlush(
      { projectId: pid, kind: "move", todoId: id, toStatus, beforeId, afterId },
      () => {
        applyTodos(prevList);
        unmarkPending(id);
      },
    );
  }

  /**
   * Delete key: a non-archived card goes straight to the top of archive;
   * an archived card is permanently deleted. Focus moves to the next sibling,
   * the previous one, or nowhere when the column empties.
   */
  function handleDelete(id: string): void {
    const todo = todos().find((t) => t.id === id);
    if (!todo) return;
    if (todo.status !== "archive") {
      handleMove(id, "archive", null, null);
      return;
    }
    const prevList = todos();
    const col = prevList
      .filter((t) => t.status === "archive")
      .sort(byRank);
    const i = col.findIndex((t) => t.id === id);
    const nextId = col[i + 1]?.id ?? col[i - 1]?.id ?? null;
    applyTodos(prevList.filter((t) => t.id !== id));
    markPending(id);
    tombstones.set(id, { rev: lastRev });
    void store
      ?.putTombstone({ todoId: id, projectId: pid, rev: lastRev, deletedAt: Date.now() })
      .catch(() => {});
    enqueueAndFlush(
      { projectId: pid, kind: "delete", todoId: id },
      () => {
        tombstones.delete(id);
        void store?.deleteTombstone(id).catch(() => {});
        applyTodos(prevList);
        unmarkPending(id);
      },
    );
    if (nextId) focusCard(nextId);
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function handleProjectRename(title: string): void {
    const clean = title.trim().slice(0, PROJECT_TITLE_MAX);
    const prev = project();
    if (!prev || prev.title === clean || !clean) return;
    setProject({ ...prev, title: clean });
    enqueueAndFlush(
      { projectId: pid, kind: "projectRename", title: clean },
      () => setProject(prev),
    );
  }

  // --- Editing ---------------------------------------------------------------
  function startEdit(id: string, initial?: string): void {
    const todo = todos().find((t) => t.id === id);
    if (!todo) return;
    setDrafts((d) => ({ ...d, [id]: initial ?? todo.title }));
    setSelectAll(initial === undefined);
    setEditingId(id);
  }

  function commitEdit(id: string, refocus: boolean): void {
    const draft = drafts()[id] ?? "";
    setEditingId(null);
    setDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
    if (draft.trim()) handleRename(id, draft);
    if (refocus) {
      // Re-select the card so keyboard flows continue. Solid 2.0 flushes
      // async, so wait a frame for the card to remount.
      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-todo-id="${CSS.escape(id)}"]`,
        );
        (el as HTMLElement | null)?.focus?.();
      });
    }
  }

  function cancelEdit(): void {
    const id = editingId();
    setEditingId(null);
    if (id) {
      setDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    }
  }

  function currentNeighbors(
    id: string,
    status: Status,
  ): { beforeId: string | null; afterId: string | null } {
    const col = columns()[status];
    const i = col.findIndex((t) => t.id === id);
    if (i < 0) return { beforeId: null, afterId: null };
    return {
      beforeId: col[i - 1]?.id ?? null,
      afterId: col[i + 1]?.id ?? null,
    };
  }

  function dropCard(
    id: string,
    toStatus: Status,
    beforeId: string | null,
    afterId: string | null,
  ): void {
    const cur = currentNeighbors(id, toStatus);
    const todo = todos().find((t) => t.id === id);
    if (todo && todo.status === toStatus && cur.beforeId === beforeId && cur.afterId === afterId) {
      return; // dropped back in place
    }
    handleMove(id, toStatus, beforeId, afterId);
  }

  function moveStatus(id: string, dir: 1 | -1): void {
    const todo = todos().find((t) => t.id === id);
    if (!todo) return;
    const ni = STATUSES.indexOf(todo.status) + dir;
    if (ni < 0 || ni >= STATUSES.length) return;
    const to = STATUSES[ni];
    const srcIdx = columns()[todo.status].findIndex((t) => t.id === id);
    const target = columns()[to];
    const pos = Math.min(srcIdx, target.length);
    dropCard(id, to, target[pos - 1]?.id ?? null, target[pos]?.id ?? null);
  }

  function reorder(id: string, dir: 1 | -1): void {
    const todo = todos().find((t) => t.id === id);
    if (!todo) return;
    const col = columns()[todo.status];
    const i = col.findIndex((t) => t.id === id);
    const j = i + dir;
    if (j < 0 || j >= col.length) return;
    const without = col.filter((t) => t.id !== id);
    dropCard(
      id,
      todo.status,
      without[j - 1]?.id ?? null,
      without[j]?.id ?? null,
    );
  }

  function focusCard(id: string): void {
    lastCardId = id;
    setFocusedId(id);
    const el = document.querySelector(`[data-todo-id="${CSS.escape(id)}"]`);
    (el as HTMLElement | null)?.focus?.();
  }

  /** Focus where the user left off, or the first card when unknown. */
  function focusLastOrFirst(): void {
    if (lastCardId && todos().some((t) => t.id === lastCardId)) {
      focusCard(lastCardId);
      return;
    }
    for (const s of STATUSES) {
      const first = columns()[s][0];
      if (first) {
        focusCard(first.id);
        return;
      }
    }
  }

  /** Track keyboard/mouse focus so bare arrows can return to it. */
  function noteFocus(e: FocusEvent): void {
    const el = e.target as HTMLElement | null;
    const id = el?.dataset?.todoId ?? null;
    if (id) lastCardId = id;
    setFocusedId(id);
  }

  // --- Touch context menu ---------------------------------------------------
  // A touch hold fires contextmenu; desktop right-click does too. Both open
  // the action sheet instead of the browser menu, wired to the same ops as
  // the keyboard. No timers: the platform owns hold detection. Inputs keep
  // their native menu (paste) since the handler lives on cards only.
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null);
  // Desktop dropdown size estimate for viewport clamping.
  const MENU_W = 230;
  const MENU_H = 320;

  function openMenu(id: string, x: number, y: number): void {
    try {
      (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(10);
    } catch {
      // Haptics are a nicety; the menu opens regardless.
    }
    setMenuAt({
      x: Math.max(8, Math.min(x, window.innerWidth - MENU_W)),
      y: Math.max(8, Math.min(y, window.innerHeight - MENU_H)),
    });
    setMenuFor(id);
    // Focus the first action so Enter/Space activates it and arrows navigate.
    requestAnimationFrame(() => {
      if (!menuFor()) return;
      document
        .querySelector<HTMLElement>(".sheet")
        ?.querySelector<HTMLElement>(".sheet-item")
        ?.focus();
    });
  }

  function closeMenu(): void {
    const id = menuFor();
    setMenuFor(null);
    setMenuAt(null);
    // Keyboard and scrim closes return focus to the card the menu was for.
    if (id && todos().some((t) => t.id === id)) focusCard(id);
  }

  function onCardContextMenu(id: string, x: number, y: number): void {
    openMenu(id, x, y);
  }

  /** HUD mode: which shortcuts are currently available. */
  type FocusKind = "idle" | "card" | "text";

  function focusKindOf(el: HTMLElement | null): FocusKind {
    const tag = el?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA") return "text";
    if (el?.closest?.("[data-todo-id]")) return "card";
    return "idle";
  }

  /**
   * Keyboard navigation: plain arrows move focus between cards, never data.
   * Vertical moves within the column; horizontal skips over empty columns to
   * the next column with cards, landing at the same position. Clamped at the
   * edges: nothing beyond the first/last populated column keeps focus put.
   */
  function focusNeighbor(id: string, dir: 1 | -1, axis: "x" | "y"): void {
    const todo = todos().find((t) => t.id === id);
    if (!todo) return;
    if (axis === "y") {
      const col = columns()[todo.status];
      const j = col.findIndex((t) => t.id === id) + dir;
      if (j < 0 || j >= col.length) return;
      focusCard(col[j].id);
      return;
    }
    let ni = STATUSES.indexOf(todo.status) + dir;
    while (
      ni >= 0 &&
      ni < STATUSES.length &&
      columns()[STATUSES[ni]].length === 0
    ) {
      ni += dir;
    }
    if (ni < 0 || ni >= STATUSES.length) return;
    const target = columns()[STATUSES[ni]];
    const srcIdx = columns()[todo.status].findIndex((t) => t.id === id);
    focusCard(target[Math.min(srcIdx, target.length - 1)].id);
  }

  function onBoardKeyDown(e: KeyboardEvent): void {
    // The action sheet owns the keyboard while open: board shortcuts (n,
    // Delete, arrows) must not reach the cards behind the scrim.
    if (menuFor()) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...document.querySelectorAll<HTMLElement>(".sheet-item")];
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next =
          at < 0
            ? dir > 0
              ? 0
              : items.length - 1
            : (at + dir + items.length) % items.length;
        items[next].focus();
      }
      return;
    }
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
      closeMenu();
      cancelEdit();
      setAdding(false);
      setAddDraft("");
      target?.blur?.();
      return;
    }
    if (inInput) return;
    const cardEl = target?.closest?.("[data-todo-id]") as HTMLElement | null;
    if ((e.key === "n" || e.key === "N") && !cardEl) {
      e.preventDefault();
      setAdding(true);
      return;
    }
    if (!cardEl?.dataset.todoId) {
      // No card focused (and not in an input): arrows enter the board at the
      // last card, or the first one when unknown. Anything else is ignored.
      // Alt+arrows are left to the browser (history nav).
      if (e.key.startsWith("Arrow") && !e.altKey) {
        e.preventDefault();
        focusLastOrFirst();
      }
      return;
    }
    const id = cardEl.dataset.todoId;
    if (e.key === "Enter") {
      e.preventDefault();
      startEdit(id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // Backspace doubles as Delete for keyboards without a Delete key.
      // Inputs return earlier, so text editing is never affected. Held-key
      // auto-repeat must not turn archive into permanent delete.
      e.preventDefault();
      if (e.repeat) return;
      handleDelete(id);
    } else if (
      (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
      !e.altKey
    ) {
      e.preventDefault();
      const dir: 1 | -1 = e.key === "ArrowRight" ? 1 : -1;
      if (e.ctrlKey || e.metaKey) moveStatus(id, dir);
      else focusNeighbor(id, dir, "x");
    } else if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.altKey
    ) {
      e.preventDefault();
      const dir: 1 | -1 = e.key === "ArrowUp" ? -1 : 1;
      if (e.ctrlKey || e.metaKey) reorder(id, dir);
      else focusNeighbor(id, dir, "y");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(id, e.key);
    }
  }

  // Global shortcut listener. Solid delegates element handlers at the render
  // root, so a div-level listener never sees keydowns from outside the app
  // (e.g. focus on body after clicking empty space — the common idle state).
  // Window sees everything; the handler above ignores anything it should not
  // touch (inputs except Escape, Alt+arrows, unknown keys).
  window.addEventListener("keydown", onBoardKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onBoardKeyDown));

  // Focus tracking for the HUD and bare-arrow entry. focusout fires before
  // the next focusin; Solid batches both, so only the final kind paints.
  function onFocusTrack(e: FocusEvent): void {
    if (e.type === "focusout") {
      setFocusKind("idle");
      setFocusedId(null);
      return;
    }
    noteFocus(e);
    setFocusKind(focusKindOf(e.target as HTMLElement | null));
  }
  window.addEventListener("focusin", onFocusTrack);
  window.addEventListener("focusout", onFocusTrack);
  onCleanup(() => {
    window.removeEventListener("focusin", onFocusTrack);
    window.removeEventListener("focusout", onFocusTrack);
  });

  // Connectivity: flush on regain, repaint status on change. Pagehide gets a
  // best-effort flush so fewer ops die with the tab (P0-5 residual).
  function onNetChange(): void {
    updateSyncStatus();
    if (typeof navigator !== "undefined" && navigator.onLine !== false) {
      void flushOutbox();
    }
  }
  window.addEventListener("online", onNetChange);
  window.addEventListener("offline", onNetChange);
  const onHide = (): void => {
    void flushOutbox();
  };
  window.addEventListener("pagehide", onHide);
  onCleanup(() => {
    window.removeEventListener("online", onNetChange);
    window.removeEventListener("offline", onNetChange);
    window.removeEventListener("pagehide", onHide);
  });

  // --- Boot (once per page load; navigations are full reloads) ---------------
  let store: LocalStore | null = null;
  let disconnect: (() => void) | null = null;

  function connectStream(sinceRev: number): void {
    disconnect?.();
    disconnect = subscribe(pid, sinceRev, {
      onEvent,
      onOpen: () => {
        setConn("live");
        updateSyncStatus();
        void flushOutbox();
      },
      onError: () => {
        setConn("reconnecting");
        updateSyncStatus();
      },
    });
  }
  onCleanup(() => disconnect?.());

  // Write-through cache: every committed state lands in the local store, so
  // the next boot renders instantly. Same granularity as the REST calls.
  // Every lastRev bump coincides with a todos/project change, so reading the
  // plain variable here always sees the current value.
  createEffect(
    () => ({ p: project(), st: state(), list: todos(), pd: pending() }),
    ({ p, st, list, pd }) => {
      if (!store || st !== "ready" || !p) return;
      void store
        .putProject({ id: p.id, title: p.title, lastRev })
        .catch(() => {});
      void store
        .replaceTodos(
          pid,
          list.map((td) => ({ ...td, projectId: pid, pending: !!pd[td.id] })),
        )
        .catch(() => {});
    },
  );

  void (async () => {
    store = await openLocalStore();
    // Preload tombstones and GC ones older than 30 days (retention policy).
    try {
      const now = Date.now();
      for (const tb of await store.tombstonesFor(pid)) {
        if (now - tb.deletedAt > 30 * 24 * 3600 * 1000) {
          await store.deleteTombstone(tb.todoId).catch(() => {});
        } else {
          tombstones.set(tb.todoId, { rev: tb.rev });
        }
      }
    } catch {
      // Tombstones are an optimization; the log still converges.
    }
    const cached = await store.getProject(pid).catch(() => undefined);
    if (cached) {
      setProject({ id: cached.id, title: cached.title });
      const ct = await store.getTodos(pid).catch(() => []);
      setTodos(ct);
      // Pending is a property of the outbox, never of the cache: a crash
      // between dequeue and ack must not strand a dimmed card.
      setPending(await pendingFromOutbox());
      lastRev = cached.lastRev;
      setState("ready");
      saveRecent({ id: cached.id, title: cached.title });
      connectStream(cached.lastRev);
    }
    try {
      const snap = await fetchSnapshot(pid);
      if (!editingProjectTitle()) {
        setProject(snap.project);
      } else {
        pendingRemoteTitle = snap.project.title;
      }
      // Snapshot is truth: exact replace without a flash storm; pending is
      // rederived from the outbox so nobody stays dimmed without a queued op.
      setTodos(snap.todos);
      setPending(await pendingFromOutbox());
      lastRev = snap.rev;
      setState("ready");
      saveRecent(snap.project);
      connectStream(snap.rev);
      updateSyncStatus();
      // Previous session may have left queued ops; flush after the stream is
      // up so acks and echoes converge through the same gates.
      void flushOutbox();
    } catch (e) {
      // With a cache we stay on it; without one show the error state.
      if (state() !== "ready") {
        setState(e instanceof ApiError && e.status === 404 ? "missing" : "failed");
      }
    }
  })();

  return (
    <div class="board">
      <Show when={conn() === "reconnecting" && state() === "ready"}>
        <div class="reconnect">{t().board.reconnecting}</div>
      </Show>
      <Show when={state() === "loading"}>
        <header class="topbar">
          <span />
          <div class="project-title">{t().board.loading}</div>
          <span />
        </header>
        <div class="columns">
          <For each={STATUSES}>
            {(s) => (
              <section class="column">
                <div class="column-head">{t().status[s]}</div>
              </section>
            )}
          </For>
        </div>
      </Show>
      <Show when={state() === "missing"}>
        <div class="center">
          <p>{t().board.invalidLink}</p>
          <a class="btn" href="/">
            {t().board.createNewProject}
          </a>
        </div>
      </Show>
      <Show when={state() === "failed"}>
        <div class="center">
          <p>{t().board.loadFailed}</p>
          <button class="btn" onClick={() => location.reload()}>
            {t().board.retry}
          </button>
        </div>
      </Show>
      <Show when={state() === "ready" && project()}>
        {(p) => (
          <>
            <header class="topbar">
              <a class="home-link" href={homeHref()} title={t().board.backHome}>
                ‹
              </a>
              <Show
                when={!editingProjectTitle()}
                fallback={
                  <input
                    class="title-input"
                    value={projectDraft()}
                    maxlength={PROJECT_TITLE_MAX}
                    onInput={(e) => setProjectDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Enter and blur share one commit path: blur the input
                      // and let onBlur save. Unmount then fires blur too, but
                      // the second save is a no-op (title already equal).
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    onBlur={() => {
                      handleProjectRename(projectDraft());
                      setEditingProjectTitle(false);
                      if (pendingRemoteTitle !== null) {
                        const remote = pendingRemoteTitle;
                        pendingRemoteTitle = null;
                        setProject((prev) =>
                          prev ? { ...prev, title: remote } : prev,
                        );
                      }
                    }}
                    ref={(el) => settleFocus(el, true)}
                  />
                }
              >
                <button
                  class="project-title"
                  title={t().board.renameProject}
                  onClick={() => {
                    setProjectDraft(p().title);
                    setEditingProjectTitle(true);
                  }}
                >
                  {p().title}
                </button>
              </Show>
              <div class="topbar-actions">
                <span class="sync-state">
                  {t().sync[sync().state]}
                  {sync().pending > 0 ? ` · ${sync().pending}` : ""}
                </span>
                <button
                  class="btn small"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(location.href)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1000);
                    })
                    .catch(() => {});
                }}
              >
                {copied() ? t().board.copied : t().board.copyLink}
              </button>
              <LocaleToggle />
              </div>
            </header>
            <div class="columns">
              <For each={STATUSES}>
                {(status) => (
                  <Column
                    status={status}
                    todos={columns()[status]}
                    adding={status === "todo" && adding()}
                    addDraft={addDraft()}
                    onAddDraft={setAddDraft}
                    onStartAdd={() => setAdding(true)}
                    onCommitAdd={(title) => {
                      handleCreate(title);
                      setAddDraft("");
                    }}
                    onCancelAdd={() => {
                      setAdding(false);
                      setAddDraft("");
                    }}
                    editingId={editingId()}
                    selectAll={selectAll()}
                    drafts={drafts()}
                    onDraft={(id, text) =>
                      setDrafts((d) => ({ ...d, [id]: text }))
                    }
                    onStartEdit={startEdit}
                    onContextMenu={onCardContextMenu}
                    onCommitEdit={commitEdit}
                    pending={pending()}
                    flashes={flashes()}
                    dropPos={dropPos()}
                    draggingId={draggingId()}
                    onDragStartCard={(id) => setDraggingId(id)}
                    onDragEndCard={() => {
                      setDraggingId(null);
                      setDropPos(null);
                    }}
                    onDropPos={setDropPos}
                    onDropCard={dropCard}
                  />
                )}
              </For>
            </div>
            <div class="hud" aria-hidden="true">
              <Show when={focusKind() === "idle"}>
                <kbd>n</kbd>
                <span>{t().hud.new}</span>
                <kbd>←→↑↓</kbd>
                <span>{t().hud.board}</span>
              </Show>
              <Show when={focusKind() === "card"}>
                <kbd>enter</kbd>
                <span>{t().hud.edit}</span>
                <kbd>←→↑↓</kbd>
                <span>{t().hud.move}</span>
                <kbd>ctrl ←→</kbd>
                <span>{t().hud.column}</span>
                <kbd>ctrl ↑↓</kbd>
                <span>{t().hud.reorder}</span>
                <kbd>del</kbd>
                <span>{focusedStatus() === "archive" ? t().hud.delete : t().hud.archive}</span>
              </Show>
              <Show when={focusKind() === "text"}>
                <kbd>enter</kbd>
                <span>{t().hud.save}</span>
                <kbd>esc</kbd>
                <span>{t().hud.cancel}</span>
              </Show>
            </div>
            <Show when={menuFor()}>
              {(getId) => {
                const archived = () =>
                  todos().find((td) => td.id === getId())?.status === "archive";
                const act = (fn: (id: string) => void) => () => {
                  const id = getId();
                  closeMenu();
                  fn(id);
                };
                const at = menuAt() ?? { x: 8, y: 8 };
                // Inline position feeds the desktop dropdown only; the mobile
                // bottom sheet is positioned purely by CSS.
                const pos =
                  window.matchMedia?.("(min-width: 901px)").matches ?? false
                    ? { left: `${at.x}px`, top: `${at.y}px` }
                    : undefined;
                return (
                  <>
                    <div class="sheet-scrim" onClick={closeMenu} />
                    <div class="sheet" role="menu" style={pos}>
                      <button class="sheet-item" onClick={act((id) => startEdit(id))}>
                        {t().menu.edit}
                      </button>
                      <button class="sheet-item" onClick={act((id) => moveStatus(id, -1))}>
                        ← {t().menu.left}
                      </button>
                      <button class="sheet-item" onClick={act((id) => moveStatus(id, 1))}>
                        → {t().menu.right}
                      </button>
                      <button class="sheet-item" onClick={act((id) => reorder(id, -1))}>
                        ↑ {t().menu.up}
                      </button>
                      <button class="sheet-item" onClick={act((id) => reorder(id, 1))}>
                        ↓ {t().menu.down}
                      </button>
                      <button
                        class="sheet-item danger"
                        onClick={act((id) => handleDelete(id))}
                      >
                        {archived() ? t().menu.delete : t().menu.archive}
                      </button>
                    </div>
                  </>
                );
              }}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

// --- Column -----------------------------------------------------------------
interface ColumnProps {
  status: Status;
  todos: Todo[];
  adding: boolean;
  addDraft: string;
  onAddDraft: (text: string) => void;
  onStartAdd: () => void;
  onCommitAdd: (title: string) => void;
  onCancelAdd: () => void;
  editingId: string | null;
  selectAll: boolean;
  drafts: Record<string, string>;
  onDraft: (id: string, text: string) => void;
  onStartEdit: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onCommitEdit: (id: string, refocus: boolean) => void;
  pending: Record<string, true>;
  flashes: Record<string, number>;
  dropPos: { status: Status; beforeId: string | null; afterId: string | null } | null;
  draggingId: string | null;
  onDragStartCard: (id: string) => void;
  onDragEndCard: () => void;
  onDropPos: (
    pos: { status: Status; beforeId: string | null; afterId: string | null } | null,
  ) => void;
  onDropCard: (
    id: string,
    toStatus: Status,
    beforeId: string | null,
    afterId: string | null,
  ) => void;
}

function Column(props: ColumnProps) {
  let bodyEl: HTMLDivElement | undefined;

  const posHere = () =>
    props.dropPos && props.dropPos.status === props.status ? props.dropPos : null;

  const track = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const els = bodyEl?.querySelectorAll("[data-todo-id]");
    let before: string | null = null;
    let after: string | null = null;
    els?.forEach((node) => {
      const el = node as HTMLElement;
      const r = el.getBoundingClientRect();
      if (after === null && e.clientY < r.top + r.height / 2) {
        after = el.dataset.todoId ?? null;
      } else if (after === null) {
        before = el.dataset.todoId ?? null;
      }
    });
    const cur = props.dropPos;
    if (
      !cur ||
      cur.status !== props.status ||
      cur.beforeId !== before ||
      cur.afterId !== after
    ) {
      props.onDropPos({ status: props.status, beforeId: before, afterId: after });
    }
  };

  return (
    <section
      class={["column", props.status === "archive" ? "muted" : ""]}
      onDragOver={track}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/plain");
        const pos = posHere();
        props.onDropPos(null);
        if (id && pos) props.onDropCard(id, pos.status, pos.beforeId, pos.afterId);
      }}
      onDragLeave={(e) => {
        if (!bodyEl?.contains(e.relatedTarget as Node | null)) {
          props.onDropPos(null);
        }
      }}
    >
      <div class="column-head">
        {t().status[props.status]}
        <span class="count">{props.todos.length}</span>
      </div>
      <Show when={props.status === "todo"}>
        <Show
          when={props.adding}
          fallback={
            <button class="add-row" onClick={props.onStartAdd}>
              {t().column.add}
            </button>
          }
        >
          <input
            class="text-input card-input"
            placeholder={t().column.newTodoPlaceholder}
            value={props.addDraft}
            maxlength={TODO_TITLE_MAX}
            onInput={(e) => props.onAddDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onCommitAdd(props.addDraft);
            }}
            onBlur={props.onCancelAdd}
            ref={(el) => settleFocus(el)}
          />
        </Show>
      </Show>
      <div class="column-body" ref={bodyEl}>
        <Show when={props.todos.length === 0 && posHere()}>
          <div class="drop-empty" />
        </Show>
        <For each={props.todos}>
          {(todo, i) => (
            <>
              <Show when={posHere()?.afterId === todo.id}>
                <div class="drop-line" />
              </Show>
              <Show
                when={props.editingId === todo.id}
                fallback={
                  <div
                    class={[
                      "card",
                      props.pending[todo.id] ? "pending" : "",
                      todo.id in props.flashes ? "flash" : "",
                      props.draggingId === todo.id ? "dragging" : "",
                    ]}
                    tabindex="0"
                    data-todo-id={todo.id}
                    title={todo.title}
                    draggable={props.editingId !== todo.id ? "true" : "false"}
                    onDragStart={(e) => {
                      e.dataTransfer?.setData("text/plain", todo.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                      props.onDragStartCard(todo.id);
                    }}
                    onDragEnd={props.onDragEndCard}
                    onClick={() => props.onStartEdit(todo.id)}
                    onDblClick={() => props.onStartEdit(todo.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      props.onContextMenu(todo.id, e.clientX, e.clientY);
                    }}
                  >
                    {todo.title}
                  </div>
                }
              >
                <input
                  class="text-input card-input"
                  value={props.drafts[todo.id] ?? todo.title}
                  maxlength={TODO_TITLE_MAX}
                  onInput={(e) => props.onDraft(todo.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") props.onCommitEdit(todo.id, true);
                  }}
                  onBlur={() => props.onCommitEdit(todo.id, false)}
                  ref={(el) => settleFocus(el, props.selectAll)}
                />
              </Show>
              <Show
                when={
                  i() === props.todos.length - 1 &&
                  posHere() !== null &&
                  posHere()?.afterId === null
                }
              >
                <div class="drop-line" />
              </Show>
            </>
          )}
        </For>
      </div>
    </section>
  );
}

/** Project id from the path. Malformed escapes fall back to the raw segment so
 * the server answers 404 instead of the render throwing. */
function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// --- App --------------------------------------------------------------------
export default function App() {
  const id = projectIdFromPath(location.pathname);
  if (id) return <Board projectId={id} />;
  return <Home />;
}
