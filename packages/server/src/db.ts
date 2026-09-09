// Server-local SQLite store. Single writer, synchronous transactions:
// the per-project atomic rev increment defines LWW order.
import { Database } from "bun:sqlite";
import type { Snapshot, Status, Todo } from "@todo/shared";

export interface Db {
  createProject(id: string, title: string): void;
  getProject(id: string): { id: string; title: string; rev: number } | null;
  renameProject(id: string, title: string): number | null;
  snapshot(id: string): Snapshot | null;
  getTodo(projectId: string, todoId: string): Todo | null;
  neighborRank(
    projectId: string,
    todoId: string,
    status: Status,
    excludeId?: string,
  ): string | undefined;
  firstRankIn(projectId: string, status: Status, excludeId?: string): string | undefined;
  createTodo(todo: Todo): number;
  renameTodo(projectId: string, todoId: string, title: string): number | null;
  moveTodo(
    projectId: string,
    todoId: string,
    toStatus: Status,
    rank: string,
  ): number | null;
  todoExists(todoId: string): { projectId: string } | null;
}

interface ProjectRow {
  id: string;
  title: string;
  rev: number;
}

interface TodoRow {
  id: string;
  project_id: string;
  title: string;
  status: Status;
  rank: string;
  updated_at: number;
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    rank: row.rank,
    updatedAt: row.updated_at,
  };
}

export function openDb(path: string): Db {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      rank TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_lookup
      ON todos(project_id, status, rank, id);
  `);

  const insertProject = db.prepare(
    "INSERT INTO projects (id, title, rev) VALUES (?, ?, 0)",
  );
  const selectProject = db.prepare(
    "SELECT id, title, rev FROM projects WHERE id = ?",
  );
  const updateProjectTitle = db.prepare(
    "UPDATE projects SET title = ?, rev = rev + 1 WHERE id = ? RETURNING rev",
  );
  const selectTodos = db.prepare(
    "SELECT id, project_id, title, status, rank, updated_at FROM todos WHERE project_id = ? ORDER BY status, rank, id",
  );
  const selectTodo = db.prepare(
    "SELECT id, project_id, title, status, rank, updated_at FROM todos WHERE project_id = ? AND id = ?",
  );
  const selectTodoAnywhere = db.prepare(
    "SELECT project_id FROM todos WHERE id = ?",
  );
  const selectNeighborRank = db.prepare(
    "SELECT rank FROM todos WHERE project_id = ? AND id = ? AND status = ? AND id != ?",
  );
  const selectFirstRank = db.prepare(
    "SELECT rank FROM todos WHERE project_id = ? AND status = ? AND id != ? ORDER BY rank, id LIMIT 1",
  );
  const insertTodo = db.prepare(
    "INSERT INTO todos (id, project_id, title, status, rank, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const updateTodoTitle = db.prepare(
    "UPDATE todos SET title = ?, updated_at = ? WHERE project_id = ? AND id = ?",
  );
  const updateTodoMove = db.prepare(
    "UPDATE todos SET status = ?, rank = ?, updated_at = ? WHERE project_id = ? AND id = ?",
  );
  const bumpRev = db.prepare(
    "UPDATE projects SET rev = rev + 1 WHERE id = ? RETURNING rev",
  );

  const now = () => Date.now();

  return {
    createProject(id, title) {
      insertProject.run(id, title);
    },

    getProject(id) {
      return (selectProject.get(id) as ProjectRow | null) ?? null;
    },

    renameProject(id, title) {
      return db.transaction(() => {
        const row = updateProjectTitle.get(title, id) as { rev: number } | null;
        return row ? row.rev : null;
      })();
    },

    snapshot(id) {
      const project = (selectProject.get(id) as ProjectRow | null) ?? null;
      if (!project) return null;
      const rows = selectTodos.all(id) as TodoRow[];
      const result: Snapshot = {
        project: { id: project.id, title: project.title },
        todos: rows.map(toTodo),
        rev: project.rev,
      };
      return result;
    },

    getTodo(projectId, todoId) {
      const row = (selectTodo.get(projectId, todoId) as TodoRow | null) ?? null;
      return row ? toTodo(row) : null;
    },

    neighborRank(projectId, todoId, status, excludeId = "") {
      const row = (selectNeighborRank.get(
        projectId,
        todoId,
        status,
        excludeId,
      ) as { rank: string } | null) ?? null;
      return row?.rank;
    },

    firstRankIn(projectId, status, excludeId = "") {
      const row = (selectFirstRank.get(
        projectId,
        status,
        excludeId,
      ) as { rank: string } | null) ?? null;
      return row?.rank;
    },

    createTodo(todo) {
      return db.transaction(() => {
        insertTodo.run(
          todo.id,
          todo.projectId,
          todo.title,
          todo.status,
          todo.rank,
          todo.updatedAt,
        );
        const row = bumpRev.get(todo.projectId) as { rev: number };
        return row.rev;
      })();
    },

    renameTodo(projectId, todoId, title) {
      return db.transaction(() => {
        const changed = updateTodoTitle.run(title, now(), projectId, todoId);
        if (changed.changes === 0) return null;
        const row = bumpRev.get(projectId) as { rev: number };
        return row.rev;
      })();
    },

    moveTodo(projectId, todoId, toStatus, rank) {
      return db.transaction(() => {
        const changed = updateTodoMove.run(
          toStatus,
          rank,
          now(),
          projectId,
          todoId,
        );
        if (changed.changes === 0) return null;
        const row = bumpRev.get(projectId) as { rev: number };
        return row.rev;
      })();
    },

    todoExists(todoId) {
      const row = (selectTodoAnywhere.get(todoId) as {
        project_id: string;
      } | null) ?? null;
      return row ? { projectId: row.project_id } : null;
    },
  };
}
