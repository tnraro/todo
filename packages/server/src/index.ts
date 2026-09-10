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
  type ServerEvent,
  type Status,
  type Todo,
} from "@todo/shared";
import { type Db, openDb } from "./db";
import { EventHub } from "./events";

export interface AppOptions {
  hub?: EventHub;
  /** Directory with the built web app (vite dist). Null disables static. */
  distDir?: string | null;
  /** Trust X-Forwarded-For for rate limiting (set behind a reverse proxy). */
  trustProxy?: boolean;
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

/** Decode a URL path segment, null when the percent-encoding is malformed. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Fixed-window limits for mutating methods: per-IP and per-project (DESIGN 9).
// Generous on purpose: they only stop floods, not fast typists.
const RATE_WINDOW_MS = 60_000;
let RATE_IP_MAX = 600;
let RATE_PROJECT_MAX = 1800;
const ipBuckets = new Map<string, { count: number; start: number }>();
const projectBuckets = new Map<string, { count: number; start: number }>();

/** Test-only hook to shrink the windows. Restored by the caller. */
export function setRateLimits(ipMax: number, projectMax: number): void {
  RATE_IP_MAX = ipMax;
  RATE_PROJECT_MAX = projectMax;
}

/** Test-only hook to isolate window counts between suites. */
export function clearRateBuckets(): void {
  ipBuckets.clear();
  projectBuckets.clear();
}

function overLimit(
  buckets: Map<string, { count: number; start: number }>,
  key: string,
  max: number,
  now: number,
): boolean {
  if (buckets.size > 10_000) buckets.clear();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    buckets.set(key, { count: 1, start: now });
    return false;
  }
  bucket.count++;
  return bucket.count > max;
}

function rateLimited(req: Request, ip: string, projectId: string | null): boolean {
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    return false;
  }
  const now = Date.now();
  if (overLimit(ipBuckets, ip, RATE_IP_MAX, now)) return true;
  return (
    projectId !== null && overLimit(projectBuckets, projectId, RATE_PROJECT_MAX, now)
  );
}

interface Neighbors {
  beforeId: string | null;
  afterId: string | null;
}

/**
 * Missed events for an SSE open, read from the persisted log. Null (truncated)
 * becomes a single reset so the client refetches. The query runs
 * synchronously before subscribe, so no event slips between replay and live.
 */
function missedEvents(
  db: Db,
  projectId: string,
  url: URL,
  req: Request,
  currentRev: number,
): ServerEvent[] {
  const headerId = req.headers.get("last-event-id");
  const queryRev = url.searchParams.get("sinceRev");
  // The header is the live cursor (auto-resent on reconnect) and wins
  // over the stale initial cursor in the query string.
  const raw = headerId ?? queryRev;
  const since = raw === null ? currentRev : Number(raw);
  const sinceRev =
    Number.isInteger(since) && since >= 0 ? since : currentRev;
  if (sinceRev >= currentRev) return [];
  return (
    db.getLog(projectId, sinceRev) ?? [{ type: "reset", rev: currentRev }]
  );
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
 * heal to open ends. With both ends open, `fallback` decides between the top
 * (move default) and the bottom (create default).
 */
function resolveRank(
  db: Db,
  projectId: string,
  status: Status,
  neighbors: Neighbors,
  excludeId: string,
  fallback: "top" | "bottom",
): string {
  let beforeRank = neighbors.beforeId
    ? (db.neighborRank(projectId, neighbors.beforeId, status, excludeId) ??
      null)
    : null;
  let afterRank = neighbors.afterId
    ? (db.neighborRank(projectId, neighbors.afterId, status, excludeId) ?? null)
    : null;
  if (beforeRank === null && afterRank === null) {
    if (fallback === "bottom") {
      beforeRank = db.lastRankIn(projectId, status, excludeId) ?? null;
    } else {
      afterRank = db.firstRankIn(projectId, status, excludeId) ?? null;
    }
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
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function createApp(db: Db, options: AppOptions = {}) {
  const hub = options.hub ?? new EventHub();
  const distDir = options.distDir === undefined ? null : options.distDir;
  const trustProxy = options.trustProxy ?? false;

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
    async fetch(req: Request, server: Server): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      // Spoofable header: only honored when the deployment declares a trusted
      // reverse proxy in front (TRUST_PROXY=1).
      const ip = trustProxy
        ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
        : server.requestIP?.(req)?.address ?? "unknown";

      if (rateLimited(req, ip, projectMatch?.[1] ?? null)) {
        return json({ error: "rate limited" }, 429);
      }

      // --- Projects -------------------------------------------------------
      if (path === "/api/projects" && req.method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | undefined;
        const title = normalizeTitle(body?.title, PROJECT_TITLE_MAX);
        if (title === null) return badRequest("title must be 1-100 chars");
        const id = generateProjectId();
        db.createProject(id, title);
        return json({ id, title }, 201);
      }

      if (projectMatch) {
        const projectId = decodeSegment(projectMatch[1]);
        if (projectId === null) return notFound("project not found");
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
          const initial = missedEvents(db, projectId, url, req, project.rev);
          return hub.stream(projectId, initial);
        }

        if (rest === "/log" && req.method === "GET") {
          const project = db.getProject(projectId);
          if (!project) return notFound("project not found");
          const raw = url.searchParams.get("since");
          const since = raw === null ? 0 : Number(raw);
          if (!Number.isInteger(since) || since < 0) {
            return badRequest("invalid since");
          }
          const events = db.getLog(projectId, since);
          if (events === null) return json({ reset: true, rev: project.rev });
          return json({ events, rev: project.rev });
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
          const rank = resolveRank(db, projectId, "todo", neighbors, "", "bottom");
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
          const todoId = decodeSegment(todoMatch[1]);
          if (todoId === null) return notFound("todo not found");
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
              "top",
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
        // PWA root files (sw.js, manifest.webmanifest, icons). Single segment
        // only: no traversal, and the extension allowlist in serveStatic
        // decides what is servable.
        if (/^\/[^/]+$/.test(path) && !path.includes("..")) {
          const root = await serveStatic(path);
          if (root) return root;
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
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  Bun.serve({
    port,
    fetch: app.fetch,
    // SSE streams live for hours; Bun's default 10s idle timeout would kill
    // them whenever pings (5s) stall past it. Disabled here instead of
    // coupling to the default: flood protection stays at the rate limiter,
    // and pings are still sent (middleboxes and half-open detection need
    // traffic, which idleTimeout: 0 does not provide).
    idleTimeout: 0,
  });
  console.log(`todo server on http://localhost:${port} (db: ${dbPath})`);
}
