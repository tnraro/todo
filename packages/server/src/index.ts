// Bun HTTP entry: REST mutations, snapshot reads, SSE stream, prod static.
// All writes go through SQLite transactions; each mutation bumps the project
// rev once and publishes exactly one SSE event (receive order = LWW order).
import type { Server } from "bun";
import {
  PROJECT_TITLE_MAX,
  TODO_TITLE_MAX,
  generateProjectId,
  isStatus,
  keyBetween,
  normalizeNeighborId,
  normalizeTitle,
  normalizeTodoId,
  type Status,
  type Todo,
} from "@todo/shared";
import { type Db, openDb } from "./db";
import { EventHub } from "./events";

export interface AppOptions {
  hub?: EventHub;
  /** Directory with the built web app (vite dist). Null disables static. */
  distDir?: string | null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

// Fixed-window per-IP limit for mutating methods. Generous on purpose:
// it only stops floods, not fast typists.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 300;
const rateBuckets = new Map<string, { count: number; start: number }>();

function rateLimited(req: Request): boolean {
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    return false;
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (rateBuckets.size > 10_000) rateBuckets.clear();
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, start: now });
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_MAX;
}

interface Neighbors {
  beforeId: string | null;
  afterId: string | null;
}

function parseNeighbors(body: Record<string, unknown>): Neighbors {
  // Missing, null, or malformed neighbor ids all heal to open ends.
  return {
    beforeId: normalizeNeighborId(body.beforeId),
    afterId: normalizeNeighborId(body.afterId),
  };
}

/**
 * Resolve an insertion rank between two neighbor cards.
 * Unknown neighbors, neighbors in other columns, and the moving card itself
 * heal to open ends. Both ends open means "top of the column".
 */
function resolveRank(
  db: Db,
  projectId: string,
  status: Status,
  neighbors: Neighbors,
  excludeId: string,
): string {
  let beforeRank = neighbors.beforeId
    ? (db.neighborRank(projectId, neighbors.beforeId, status, excludeId) ??
      null)
    : null;
  let afterRank = neighbors.afterId
    ? (db.neighborRank(projectId, neighbors.afterId, status, excludeId) ?? null)
    : null;
  if (beforeRank === null && afterRank === null) {
    afterRank = db.firstRankIn(projectId, status, excludeId) ?? null;
  }
  if (beforeRank !== null && afterRank !== null && beforeRank >= afterRank) {
    afterRank = null; // inconsistent pair: keep the upper anchor
  }
  return keyBetween(beforeRank, afterRank);
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function createApp(db: Db, options: AppOptions = {}) {
  const hub = options.hub ?? new EventHub();
  const distDir = options.distDir === undefined ? null : options.distDir;

  async function serveStatic(path: string): Promise<Response | null> {
    if (!distDir) return null;
    const file = Bun.file(distDir + path);
    if (!(await file.exists())) return null;
    const dot = path.lastIndexOf(".");
    const type = dot >= 0 ? CONTENT_TYPES[path.slice(dot)] : undefined;
    return new Response(file, {
      headers: type ? { "content-type": type } : {},
    });
  }

  return {
    hub,
    async fetch(req: Request, _server: Server): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (rateLimited(req)) return json({ error: "rate limited" }, 429);

      // --- Projects -------------------------------------------------------
      if (path === "/api/projects" && req.method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const title = normalizeTitle(body?.title, PROJECT_TITLE_MAX);
        if (title === null) return badRequest("title must be 1-100 chars");
        const id = generateProjectId();
        db.createProject(id, title);
        return json({ id, title }, 201);
      }

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const rest = projectMatch[2] ?? "";

        if (rest === "" && req.method === "GET") {
          const snapshot = db.snapshot(projectId);
          return snapshot ? json(snapshot) : notFound("project not found");
        }

        if (rest === "" && req.method === "PATCH") {
          const body = (await readBody(req)) as Record<string, unknown> | undefined;
          const title = normalizeTitle(body?.title, PROJECT_TITLE_MAX);
          if (title === null) return badRequest("title must be 1-100 chars");
          const rev = db.renameProject(projectId, title);
          if (rev === null) return notFound("project not found");
          const project = { id: projectId, title };
          hub.publish(projectId, { type: "project:renamed", rev, project });
          return json({ project, rev });
        }

        if (rest === "/events" && req.method === "GET") {
          const project = db.getProject(projectId);
          if (!project) return notFound("project not found");
          const headerId = req.headers.get("last-event-id");
          const queryRev = url.searchParams.get("sinceRev");
          // The header is the live cursor (auto-resent on reconnect) and wins
          // over the stale initial cursor in the query string.
          const raw = headerId ?? queryRev;
          const since = raw === null ? project.rev : Number(raw);
          const sinceRev = Number.isInteger(since) && since >= 0 ? since : project.rev;
          return hub.stream(projectId, sinceRev, project.rev);
        }

        if (rest === "/todos" && req.method === "POST") {
          if (!db.getProject(projectId)) return notFound("project not found");
          const body = (await readBody(req)) as Record<string, unknown> | undefined;
          if (!body || typeof body !== "object") return badRequest("invalid body");
          const id = normalizeTodoId(body.id);
          const title = normalizeTitle(body.title, TODO_TITLE_MAX);
          if (id === null) return badRequest("invalid todo id");
          if (title === null) return badRequest("title must be 1-200 chars");
          const neighbors = parseNeighbors(body);

          const existing = db.getTodo(projectId, id);
          if (existing) {
            const current = db.getProject(projectId)!;
            return json({ todo: existing, rev: current.rev });
          }
          if (db.todoExists(id)) {
            return json({ error: "todo id already used" }, 409);
          }
          const rank = resolveRank(db, projectId, "todo", neighbors, "");
          const todo: Todo = {
            id,
            projectId,
            title,
            status: "todo",
            rank,
            updatedAt: Date.now(),
          };
          const rev = db.createTodo(todo);
          hub.publish(projectId, { type: "todo:created", rev, todo });
          return json({ todo, rev }, 201);
        }

        const todoMatch = rest.match(/^\/todos\/([^/]+)(\/.*)?$/);
        if (todoMatch) {
          const todoId = decodeURIComponent(todoMatch[1]);
          const action = todoMatch[2] ?? "";

          if (action === "" && req.method === "PATCH") {
            const body = (await readBody(req)) as Record<string, unknown> | undefined;
            const title = normalizeTitle(body?.title, TODO_TITLE_MAX);
            if (title === null) return badRequest("title must be 1-200 chars");
            const rev = db.renameTodo(projectId, todoId, title);
            if (rev === null) return notFound("todo not found");
            const todo = db.getTodo(projectId, todoId)!;
            hub.publish(projectId, { type: "todo:renamed", rev, todo });
            return json({ todo, rev });
          }

          if (action === "" && req.method === "DELETE") {
            const result = db.deleteTodo(projectId, todoId);
            if (result === null) return notFound("todo not found");
            if (result.outcome === "active") {
              return json({ error: "only archived todos can be deleted" }, 409);
            }
            hub.publish(projectId, { type: "todo:deleted", rev: result.rev, todoId });
            return json({ rev: result.rev });
          }

          if (action === "/move" && req.method === "POST") {
            const body = (await readBody(req)) as Record<string, unknown> | undefined;
            if (!body || typeof body !== "object") return badRequest("invalid body");
            if (!isStatus(body.toStatus)) return badRequest("invalid status");
            const neighbors = parseNeighbors(body);
            if (!db.getTodo(projectId, todoId)) return notFound("todo not found");
            const rank = resolveRank(
              db,
              projectId,
              body.toStatus,
              neighbors,
              todoId,
            );
            const rev = db.moveTodo(projectId, todoId, body.toStatus, rank);
            if (rev === null) return notFound("todo not found");
            const todo = db.getTodo(projectId, todoId)!;
            hub.publish(projectId, { type: "todo:moved", rev, todo });
            return json({ todo, rev });
          }
        }

        return notFound("not found");
      }

      // --- Web app (prod static; in dev Vite serves these) -----------------
      if (req.method === "GET") {
        if (path === "/" || /^\/p\/[^/]+$/.test(path)) {
          const index = await serveStatic("/index.html");
          if (index) return index;
          return distDir
            ? notFound("not found")
            : json({ error: "web build not found; run bun run build" }, 404);
        }
        if (path.startsWith("/assets/") && !path.includes("..")) {
          const asset = await serveStatic(path);
          if (asset) return asset;
        }
      }

      return notFound("not found");
    },
  };
}

export type App = ReturnType<typeof createApp>;

// --- Entry -----------------------------------------------------------------
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3001);
  const dbPath = process.env.TODO_DB ?? "data/app.db";
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const distDir =
    process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
  const { existsSync } = await import("node:fs");
  const app = createApp(db, {
    distDir: existsSync(distDir) ? distDir : null,
  });
  Bun.serve({ port, fetch: app.fetch });
  console.log(`todo server on http://localhost:${port} (db: ${dbPath})`);
}
