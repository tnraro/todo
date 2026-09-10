// Server-local SQLite store. Single writer, synchronous transactions:
// the per-project atomic rev increment defines LWW order.
import { Database } from "bun:sqlite";
import type { Project, ServerEvent, Snapshot, Status, Todo } from "@todo/shared";

/** Retained events per project. Older rows are dropped; clients that fall
 * behind get a reset + snapshot instead (same as Linear's firstSyncId). */
let LOG_CAP = 1000;

/** Test-only hook to shrink retention. Restored by the caller. */
export function setLogCap(n: number): void {
  LOG_CAP = n;
}

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
  lastRankIn(projectId: string, status: Status, excludeId?: string): string | undefined;
  createTodo(todo: Todo): number;
  renameTodo(projectId: string, todoId: string, title: string): number | null;
  moveTodo(
    projectId: string,
    todoId: string,
    toStatus: Status,
    rank: string,
  ): number | null;
  /**
   * Hard delete. Only archived todos may be deleted: returns "archived" when
   * removed (with the new rev), "active" when the todo exists but is not in
   * archive, null when missing.
   */
  deleteTodo(
    projectId: string,
    todoId: string,
  ): { outcome: "deleted"; rev: number } | { outcome: "active" } | null;
  todoExists(todoId: string): { projectId: string } | null;
  /**
   * Events with rev > since, oldest first (max 500 per call; the client
   * loops). Null when `since` predates retention: the client must reset to
   * a snapshot instead.
   */
  getLog(projectId: string, since: number): ServerEvent[] | null;
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
    CREATE TABLE IF NOT EXISTS project_events (
      project_id TEXT NOT NULL REFERENCES projects(id),
      rev INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (project_id, rev)
    );
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
  const selectLastRank = db.prepare(
    "SELECT rank FROM todos WHERE project_id = ? AND status = ? AND id != ? ORDER BY rank DESC, id DESC LIMIT 1",
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
  const deleteTodoRow = db.prepare(
    "DELETE FROM todos WHERE project_id = ? AND id = ?",
  );
  const insertEvent = db.prepare(
    "INSERT INTO project_events (project_id, rev, type, payload) VALUES (?, ?, ?, ?)",
  );
  const selectCutoff = db.prepare(
    "SELECT rev FROM project_events WHERE project_id = ? ORDER BY rev DESC LIMIT 1 OFFSET ?",
  );
  const deleteBelow = db.prepare(
    "DELETE FROM project_events WHERE project_id = ? AND rev < ?",
  );
  const selectLog = db.prepare(
    "SELECT rev, type, payload FROM project_events WHERE project_id = ? AND rev > ? ORDER BY rev ASC LIMIT 500",
  );
  const selectOldestRev = db.prepare(
    "SELECT MIN(rev) AS min_rev FROM project_events WHERE project_id = ?",
  );

  const now = () => Date.now();

  /** Append one event at the already-bumped rev; trim beyond retention. */
  function logEvent(
    projectId: string,
    rev: number,
    type: ServerEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    insertEvent.run(projectId, rev, type, JSON.stringify(payload));
    const cutoff = selectCutoff.get(projectId, LOG_CAP - 1) as
      | { rev: number }
      | null;
    if (cutoff) deleteBelow.run(projectId, cutoff.rev);
  }

  function toEvent(row: { rev: number; type: string; payload: string }): ServerEvent {
    const payload = JSON.parse(row.payload) as {
      project?: Project;
      todo?: Todo;
      todoId?: string;
    };
    if (row.type === "project:renamed" && payload.project) {
      return { type: "project:renamed", rev: row.rev, project: payload.project };
    }
    if (row.type === "todo:deleted" && payload.todoId) {
      return { type: "todo:deleted", rev: row.rev, todoId: payload.todoId };
    }
    return { type: row.type, rev: row.rev, todo: payload.todo } as ServerEvent;
  }

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
        if (!row) return null;
        logEvent(id, row.rev, "project:renamed", {
          project: { id, title },
        });
        return row.rev;
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

    lastRankIn(projectId, status, excludeId = "") {
      const row = (selectLastRank.get(
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
        logEvent(todo.projectId, row.rev, "todo:created", { todo });
        return row.rev;
      })();
    },

    renameTodo(projectId, todoId, title) {
      return db.transaction(() => {
        const changed = updateTodoTitle.run(title, now(), projectId, todoId);
        if (changed.changes === 0) return null;
        const row = bumpRev.get(projectId) as { rev: number };
        const todo = toTodo(
          selectTodo.get(projectId, todoId) as TodoRow,
        );
        logEvent(projectId, row.rev, "todo:renamed", { todo });
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
        const todo = toTodo(
          selectTodo.get(projectId, todoId) as TodoRow,
        );
        logEvent(projectId, row.rev, "todo:moved", { todo });
        return row.rev;
      })();
    },

    deleteTodo(projectId, todoId) {
      return db.transaction(() => {
        const existing =
          (selectTodo.get(projectId, todoId) as TodoRow | null) ?? null;
        if (!existing) return null;
        if (existing.status !== "archive") return { outcome: "active" } as const;
        deleteTodoRow.run(projectId, todoId);
        const rev = bumpRev.get(projectId) as { rev: number };
        logEvent(projectId, rev.rev, "todo:deleted", { todoId });
        return { outcome: "deleted", rev: rev.rev } as const;
      })();
    },

    todoExists(todoId) {
      const row = (selectTodoAnywhere.get(todoId) as {
        project_id: string;
      } | null) ?? null;
      return row ? { projectId: row.project_id } : null;
    },

    getLog(projectId, since) {
      const project = (selectProject.get(projectId) as ProjectRow | null) ?? null;
      if (!project) return null;
      const oldest = (selectOldestRev.get(projectId) as {
        min_rev: number | null;
      } | null)?.min_rev;
      // Complete only when every rev above `since` is retained.
      if (oldest !== null && oldest !== undefined && oldest > since + 1) {
        return null;
      }
      if ((oldest === null || oldest === undefined) && since < project.rev) {
        return null;
      }
      const rows = selectLog.all(projectId, since) as {
        rev: number;
        type: string;
        payload: string;
      }[];
      return rows.map(toEvent);
    },
  };
}
