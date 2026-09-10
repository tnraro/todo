// Local-first store: IndexedDB (via idb) with an in-memory fallback.
// Schema v1. If the version ever bumps, old data is dropped and reseeded
// from the server (escape hatch beats client-side migrations at this scale).
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Status, Todo } from "@todo/shared";

export const STORE_VERSION = 1;

/** Todo row with its sync state. `pending` survives reloads. */
export interface LocalTodo extends Todo {
  pending: boolean;
}

export interface LocalProject {
  id: string;
  title: string;
  /** Last server rev applied. Basis for delta pull and SSE subscribe. */
  lastRev: number;
}

export type OpKind = "create" | "rename" | "move" | "delete" | "projectRename";

export interface OutboxOp {
  seq?: number;
  projectId: string;
  kind: OpKind;
  todoId?: string;
  title?: string;
  toStatus?: Status;
  beforeId?: string | null;
  afterId?: string | null;
  attempts: number;
  createdAt: number;
}

export interface Tombstone {
  todoId: string;
  projectId: string;
  /** Suppress only events with rev <= this (see P0-1: ids are reusable). */
  rev: number;
  deletedAt: number;
}

interface KanbanDB extends DBSchema {
  projects: { key: string; value: LocalProject };
  todos: {
    key: string;
    value: LocalTodo;
    indexes: { "by-project": string };
  };
  outbox: {
    key: number;
    value: OutboxOp;
    autoIncrement: true;
    indexes: { "by-project": string };
  };
  tombstones: { key: string; value: Tombstone };
}

export interface LocalStore {
  readonly persistent: boolean;
  getProject(id: string): Promise<LocalProject | undefined>;
  putProject(project: LocalProject): Promise<void>;
  getTodos(projectId: string): Promise<LocalTodo[]>;
  putTodos(todos: LocalTodo[]): Promise<void>;
  deleteTodo(id: string): Promise<void>;
  /** Replace a project's todos wholesale (snapshot seed/pull). */
  replaceTodos(projectId: string, todos: LocalTodo[]): Promise<void>;
  enqueue(op: Omit<OutboxOp, "seq" | "attempts" | "createdAt">): Promise<number>;
  listOutbox(projectId: string): Promise<OutboxOp[]>;
  setAttempts(seq: number, attempts: number): Promise<void>;
  removeOps(seqs: number[]): Promise<void>;
  putTombstone(tombstone: Tombstone): Promise<void>;
  getTombstone(todoId: string): Promise<Tombstone | undefined>;
  deleteTombstone(todoId: string): Promise<void>;
  tombstonesFor(projectId: string): Promise<Tombstone[]>;
  /** Forget a project locally (privacy). Server copy is untouched. */
  clearProject(projectId: string): Promise<void>;
  close(): void;
}

class IdbStore implements LocalStore {
  readonly persistent = true;
  constructor(private db: IDBPDatabase<KanbanDB>) {}

  getProject(id: string): Promise<LocalProject | undefined> {
    return this.db.get("projects", id);
  }
  putProject(project: LocalProject): Promise<void> {
    return this.db.put("projects", project).then(() => undefined);
  }
  getTodos(projectId: string): Promise<LocalTodo[]> {
    return this.db.getAllFromIndex("todos", "by-project", projectId);
  }
  async putTodos(todos: LocalTodo[]): Promise<void> {
    const tx = this.db.transaction("todos", "readwrite");
    await Promise.all(todos.map((t) => tx.store.put(t)));
    await tx.done;
  }
  deleteTodo(id: string): Promise<void> {
    return this.db.delete("todos", id);
  }
  async replaceTodos(projectId: string, todos: LocalTodo[]): Promise<void> {
    const tx = this.db.transaction("todos", "readwrite");
    const keep = new Set(todos.map((t) => t.id));
    for (const existing of await tx.store.index("by-project").getAll(projectId)) {
      if (!keep.has(existing.id)) await tx.store.delete(existing.id);
    }
    await Promise.all(todos.map((t) => tx.store.put(t)));
    await tx.done;
  }
  async enqueue(
    op: Omit<OutboxOp, "seq" | "attempts" | "createdAt">,
  ): Promise<number> {
    const seq = (await this.db.add("outbox", {
      ...op,
      attempts: 0,
      createdAt: Date.now(),
    })) as number;
    return seq;
  }
  listOutbox(projectId: string): Promise<OutboxOp[]> {
    return this.db.getAllFromIndex("outbox", "by-project", projectId);
  }
  async setAttempts(seq: number, attempts: number): Promise<void> {
    const op = await this.db.get("outbox", seq);
    if (op) await this.db.put("outbox", { ...op, attempts });
  }
  async removeOps(seqs: number[]): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    await Promise.all(seqs.map((seq) => tx.store.delete(seq)));
    await tx.done;
  }
  putTombstone(tombstone: Tombstone): Promise<void> {
    return this.db.put("tombstones", tombstone).then(() => undefined);
  }
  getTombstone(todoId: string): Promise<Tombstone | undefined> {
    return this.db.get("tombstones", todoId);
  }
  deleteTombstone(todoId: string): Promise<void> {
    return this.db.delete("tombstones", todoId);
  }
  async tombstonesFor(projectId: string): Promise<Tombstone[]> {
    return (await this.db.getAll("tombstones")).filter(
      (tb) => tb.projectId === projectId,
    );
  }
  async clearProject(projectId: string): Promise<void> {
    const tx = this.db.transaction(
      ["projects", "todos", "outbox", "tombstones"],
      "readwrite",
    );
    await tx.objectStore("projects").delete(projectId);
    for (const t of await tx.objectStore("todos").index("by-project").getAll(projectId)) {
      await tx.objectStore("todos").delete(t.id);
    }
    for (const o of await tx.objectStore("outbox").index("by-project").getAll(projectId)) {
      if (o.seq !== undefined) await tx.objectStore("outbox").delete(o.seq);
    }
    const allTombs = await tx.objectStore("tombstones").getAll();
    for (const tb of allTombs) {
      if (tb.projectId === projectId) {
        await tx.objectStore("tombstones").delete(tb.todoId);
      }
    }
    await tx.done;
  }
  close(): void {
    this.db.close();
  }
}

class MemoryStore implements LocalStore {
  readonly persistent = false;
  private projects = new Map<string, LocalProject>();
  private todos = new Map<string, LocalTodo>();
  private outbox = new Map<number, OutboxOp>();
  private tombstones = new Map<string, Tombstone>();
  private seq = 0;

  async getProject(id: string): Promise<LocalProject | undefined> {
    return this.projects.get(id);
  }
  async putProject(project: LocalProject): Promise<void> {
    this.projects.set(project.id, { ...project });
  }
  async getTodos(projectId: string): Promise<LocalTodo[]> {
    return [...this.todos.values()]
      .filter((t) => t.projectId === projectId)
      .map((t) => ({ ...t }));
  }
  async putTodos(todos: LocalTodo[]): Promise<void> {
    for (const t of todos) this.todos.set(t.id, { ...t });
  }
  async deleteTodo(id: string): Promise<void> {
    this.todos.delete(id);
  }
  async replaceTodos(projectId: string, todos: LocalTodo[]): Promise<void> {
    for (const [id, t] of this.todos) {
      if (t.projectId === projectId) this.todos.delete(id);
    }
    await this.putTodos(todos);
  }
  async enqueue(
    op: Omit<OutboxOp, "seq" | "attempts" | "createdAt">,
  ): Promise<number> {
    const seq = ++this.seq;
    this.outbox.set(seq, { ...op, seq, attempts: 0, createdAt: Date.now() });
    return seq;
  }
  async listOutbox(projectId: string): Promise<OutboxOp[]> {
    return [...this.outbox.values()]
      .filter((o) => o.projectId === projectId)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  async setAttempts(seq: number, attempts: number): Promise<void> {
    const op = this.outbox.get(seq);
    if (op) this.outbox.set(seq, { ...op, attempts });
  }
  async removeOps(seqs: number[]): Promise<void> {
    for (const seq of seqs) this.outbox.delete(seq);
  }
  async putTombstone(tombstone: Tombstone): Promise<void> {
    this.tombstones.set(tombstone.todoId, { ...tombstone });
  }
  async getTombstone(todoId: string): Promise<Tombstone | undefined> {
    return this.tombstones.get(todoId);
  }
  async deleteTombstone(todoId: string): Promise<void> {
    this.tombstones.delete(todoId);
  }
  async tombstonesFor(projectId: string): Promise<Tombstone[]> {
    return [...this.tombstones.values()].filter(
      (tb) => tb.projectId === projectId,
    );
  }
  async clearProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
    for (const [id, t] of this.todos) {
      if (t.projectId === projectId) this.todos.delete(id);
    }
    for (const [seq, o] of this.outbox) {
      if (o.projectId === projectId) this.outbox.delete(seq);
    }
    for (const [id, tb] of this.tombstones) {
      if (tb.projectId === projectId) this.tombstones.delete(id);
    }
  }
  close(): void {}
}

function openDb(name: string): Promise<IDBPDatabase<KanbanDB>> {
  return openDB<KanbanDB>(name, STORE_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion > 0) {
        // Migration policy: wipe and reseed from the server. Client schema
        // changes are rare and the server stays authoritative, so an escape
        // hatch beats per-version migrations (Linear lesson: migrations run
        // on every device).
        for (const store of ["projects", "todos", "outbox", "tombstones"] as const) {
          if (db.objectStoreNames.contains(store)) {
            db.deleteObjectStore(store);
          }
        }
      }
      db.createObjectStore("projects", { keyPath: "id" });
      const todos = db.createObjectStore("todos", { keyPath: "id" });
      todos.createIndex("by-project", "projectId");
      const outbox = db.createObjectStore("outbox", {
        keyPath: "seq",
        autoIncrement: true,
      });
      outbox.createIndex("by-project", "projectId");
      db.createObjectStore("tombstones", { keyPath: "todoId" });
    },
  });
}

/** Open the local store, falling back to memory when IDB is unavailable. */
export async function openLocalStore(
  name = "todo-kanban",
): Promise<LocalStore> {
  try {
    if (typeof indexedDB === "undefined") return new MemoryStore();
    const db = await openDb(name);
    // Best-effort eviction defense; failure is non-fatal (P0-5 residual).
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Ignore: persistence is a hint, not a requirement.
    }
    return new IdbStore(db);
  } catch {
    return new MemoryStore();
  }
}

/** Test escape hatch: memory store with the same contract. */
export function openMemoryStore(): LocalStore {
  return new MemoryStore();
}
