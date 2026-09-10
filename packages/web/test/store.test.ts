// Store contract tests: run the same suite against IndexedDB
// (fake-indexeddb) and the in-memory fallback. Run via `bun run test:web`.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  openLocalStore,
  openMemoryStore,
  type LocalStore,
} from "../src/store";

let dbN = 0;
async function openIdb(): Promise<LocalStore> {
  return openLocalStore(`test-${Date.now()}-${dbN++}`);
}

const implementations: [string, () => Promise<LocalStore>][] = [
  ["idb", openIdb],
  ["memory", async () => openMemoryStore()],
];

for (const [name, open] of implementations) {
  describe(`store/${name}`, () => {
    let store: LocalStore;
    const pid = `p-${name}`;

    async function fresh(): Promise<void> {
      store?.close();
      store = await open();
    }

    afterEach(() => store?.close());

    test("projects round-trip", async () => {
      await fresh();
      expect(await store.getProject(pid)).toBeUndefined();
      await store.putProject({ id: pid, title: "T", lastRev: 7 });
      expect(await store.getProject(pid)).toEqual({
        id: pid,
        title: "T",
        lastRev: 7,
      });
    });

    test("todos round-trip by project", async () => {
      await fresh();
      await store.putTodos([
        { id: "a", projectId: pid, title: "a", status: "todo", rank: "5", updatedAt: 1, pending: false },
        { id: "b", projectId: pid, title: "b", status: "doing", rank: "5", updatedAt: 1, pending: true },
        { id: "x", projectId: "other", title: "x", status: "todo", rank: "5", updatedAt: 1, pending: false },
      ]);
      const list = await store.getTodos(pid);
      expect(list.map((t) => t.id).sort()).toEqual(["a", "b"]);
      expect(list.find((t) => t.id === "b")?.pending).toBe(true);
      await store.deleteTodo("a");
      expect((await store.getTodos(pid)).map((t) => t.id)).toEqual(["b"]);
    });

    test("outbox is FIFO per project", async () => {
      await fresh();
      await store.enqueue({ projectId: pid, kind: "rename", todoId: "a", title: "x" });
      await store.enqueue({ projectId: pid, kind: "move", todoId: "a", toStatus: "doing", beforeId: null, afterId: null });
      await store.enqueue({ projectId: "other", kind: "rename", todoId: "z", title: "z" });
      const ops = await store.listOutbox(pid);
      expect(ops.map((o) => o.kind)).toEqual(["rename", "move"]);
      expect(ops[0].attempts).toBe(0);
      await store.setAttempts(ops[0].seq!, 3);
      expect((await store.listOutbox(pid))[0].attempts).toBe(3);
      await store.removeOps([ops[0].seq!]);
      expect((await store.listOutbox(pid)).map((o) => o.kind)).toEqual(["move"]);
    });

    test("replaceTodos swaps a project's set", async () => {
      await fresh();
      await store.putTodos([
        { id: "a", projectId: pid, title: "a", status: "todo", rank: "5", updatedAt: 1, pending: false },
        { id: "b", projectId: pid, title: "b", status: "todo", rank: "6", updatedAt: 1, pending: false },
        { id: "x", projectId: "other", title: "x", status: "todo", rank: "5", updatedAt: 1, pending: false },
      ]);
      await store.replaceTodos(pid, [
        { id: "b", projectId: pid, title: "b2", status: "doing", rank: "5", updatedAt: 2, pending: false },
        { id: "c", projectId: pid, title: "c", status: "todo", rank: "5", updatedAt: 2, pending: true },
      ]);
      expect((await store.getTodos(pid)).map((t) => t.id).sort()).toEqual(["b", "c"]);
      expect((await store.getTodos("other")).map((t) => t.id)).toEqual(["x"]);
    });

    test("tombstones round-trip", async () => {
      await fresh();
      expect(await store.getTombstone("gone")).toBeUndefined();
      await store.putTombstone({ todoId: "gone", projectId: pid, rev: 9, deletedAt: 1 });
      expect(await store.getTombstone("gone")).toEqual({
        todoId: "gone",
        projectId: pid,
        rev: 9,
        deletedAt: 1,
      });
      await store.deleteTombstone("gone");
      expect(await store.getTombstone("gone")).toBeUndefined();
    });

    test("tombstonesFor lists a project's tombstones", async () => {
      await fresh();
      await store.putTombstone({ todoId: "g1", projectId: pid, rev: 1, deletedAt: 1 });
      await store.putTombstone({ todoId: "g2", projectId: "other", rev: 1, deletedAt: 1 });
      expect((await store.tombstonesFor(pid)).map((t) => t.todoId)).toEqual(["g1"]);
    });

    test("clearProject forgets everything local", async () => {
      await fresh();
      await store.putProject({ id: pid, title: "T", lastRev: 1 });
      await store.putTodos([
        { id: "a", projectId: pid, title: "a", status: "todo", rank: "5", updatedAt: 1, pending: false },
      ]);
      await store.enqueue({ projectId: pid, kind: "rename", todoId: "a", title: "x" });
      await store.putTombstone({ todoId: "g", projectId: pid, rev: 2, deletedAt: 1 });
      await store.clearProject(pid);
      expect(await store.getProject(pid)).toBeUndefined();
      expect(await store.getTodos(pid)).toEqual([]);
      expect(await store.listOutbox(pid)).toEqual([]);
      expect(await store.getTombstone("g")).toBeUndefined();
    });
  });
}
