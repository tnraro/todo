// Single-view kanban board. No client router: "/" renders Home, "/p/:id"
// renders Board, navigations are real page loads. Server echo is truth;
// local writes are optimistic with rollback on failure.
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import {
  STATUSES,
  keyBetween,
  type Project,
  type ServerEvent,
  type Status,
  type Todo,
} from "@todo/shared";
import {
  ApiError,
  createProject,
  createTodo,
  deleteTodo,
  fetchSnapshot,
  genTodoId,
  moveTodo,
  renameProject,
  renameTodo,
  subscribe,
} from "./api";
import { locale, setLocale, t } from "./i18n";

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
  const recents = loadRecents();

  const create = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      const project = await createProject(title().trim() || t().untitled);
      location.href = `/p/${project.id}`;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="home">
      <h1>todo</h1>
      <div class="home-create">
        <input
          class="text-input"
          placeholder={t().home.titlePlaceholder}
          value={title()}
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
      <Show when={recents.length > 0}>
        <div class="recents">
          <div class="recents-title">{t().home.recent}</div>
          <For each={recents}>
            {(r) => (
              <a class="recent-link" href={`/p/${r.id}`}>
                {r.title || t().untitled}
              </a>
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
    const prev = todos();
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
    const { list, changed } = mergeTodos(todos(), next);
    applyTodos(list);
    flash(changed);
  }

  function acceptTodo(todo: Todo, rev: number): void {
    if (rev > lastRev) {
      lastRev = rev;
      const prev = todos();
      const idx = prev.findIndex((t) => t.id === todo.id);
      const next =
        idx < 0
          ? [...prev, todo]
          : [...prev.slice(0, idx), todo, ...prev.slice(idx + 1)];
      const { list, changed } = mergeTodos(prev, next);
      applyTodos(list);
      flash(changed);
    }
    setPending((p) => {
      if (!p[todo.id]) return p;
      const next = { ...p };
      delete next[todo.id];
      return next;
    });
  }

  async function refetch(): Promise<void> {
    try {
      const snap = await fetchSnapshot(pid);
      if (!editingProjectTitle()) {
        setProject(snap.project);
      } else {
        pendingRemoteTitle = snap.project.title;
      }
      lastRev = snap.rev;
      applySnapshotTodos(snap.todos);
    } catch {
      // Keep showing the last known state; the reconnect bar stays up.
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
      applyTodos(todos().filter((t) => t.id !== event.todoId));
      return;
    }
    const prev = todos();
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

  function handleCreate(title: string): void {
    const clean = title.trim();
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
    void createTodo(pid, { id, title: clean })
      .then(({ todo, rev }) => acceptTodo(todo, rev))
      .catch(() => {
        applyTodos((prev) => prev.filter((t) => t.id !== id));
        unmarkPending(id);
      });
  }

  function handleRename(id: string, title: string): void {
    const clean = title.trim();
    const prev = todos().find((t) => t.id === id);
    if (!prev || prev.title === clean || !clean) return;
    applyTodos((list) => list.map((t) => (t.id === id ? { ...t, title: clean } : t)));
    markPending(id);
    void renameTodo(pid, id, clean)
      .then(({ todo, rev }) => acceptTodo(todo, rev))
      .catch(() => {
        applyTodos((list) => list.map((t) => (t.id === id ? prev : t)));
        unmarkPending(id);
      });
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
    void moveTodo(pid, id, toStatus, beforeId, afterId)
      .then(({ todo, rev }) => acceptTodo(todo, rev))
      .catch(() => {
        applyTodos(prevList);
        unmarkPending(id);
      });
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
    void deleteTodo(pid, id)
      .then(({ rev }) => {
        if (rev > lastRev) lastRev = rev;
        unmarkPending(id);
      })
      .catch(() => {
        applyTodos(prevList);
        unmarkPending(id);
      });
    if (nextId) focusCard(nextId);
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function handleProjectRename(title: string): void {
    const clean = title.trim();
    const prev = project();
    if (!prev || prev.title === clean || !clean) return;
    setProject({ ...prev, title: clean });
    void renameProject(pid, clean)
      .then(({ project: next, rev }) => {
        if (rev > lastRev) lastRev = rev;
        setProject(next);
        saveRecent(next);
      })
      .catch(() => setProject(prev));
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
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
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
      // Inputs return earlier, so text editing is never affected.
      e.preventDefault();
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

  // --- Boot (once per page load; navigations are full reloads) ---------------
  fetchSnapshot(pid)
    .then((snap) => {
      setProject(snap.project);
      applyTodos(snap.todos);
      lastRev = snap.rev;
      setState("ready");
      saveRecent(snap.project);
      subscribe(pid, snap.rev, {
        onEvent,
        onOpen: () => setConn("live"),
        onError: () => setConn("reconnecting"),
      });
    })
    .catch((e) => {
      setState(e instanceof ApiError && e.status === 404 ? "missing" : "failed");
    });

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
                  >
                    {todo.title}
                  </div>
                }
              >
                <input
                  class="text-input card-input"
                  value={props.drafts[todo.id] ?? todo.title}
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

// --- App --------------------------------------------------------------------
export default function App() {
  const match = location.pathname.match(/^\/p\/([^/]+)$/);
  if (match) return <Board projectId={decodeURIComponent(match[1])} />;
  return <Home />;
}
