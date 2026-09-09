// Shared contract between @todo/server and @todo/web.
// Single source of truth for types, limits, and validation (DRY).

export const STATUSES = ["todo", "doing", "done", "archive"] as const;
export type Status = (typeof STATUSES)[number];

export const PROJECT_TITLE_MAX = 100;
export const TODO_TITLE_MAX = 200;
export const TODO_ID_MAX = 64;

export interface Project {
  id: string;
  title: string;
}

export interface Todo {
  id: string;
  projectId: string;
  title: string;
  status: Status;
  /** Opaque fractional sort key. Lexicographic order is display order. */
  rank: string;
  /** Server receive time, ms epoch. Basis for LWW. */
  updatedAt: number;
}

export interface Snapshot {
  project: Project;
  todos: Todo[];
  /** Project-global monotonic sequence. Orders SSE events. */
  rev: number;
}

export type ServerEvent =
  | { type: "project:renamed"; rev: number; project: Project }
  | { type: "todo:created"; rev: number; todo: Todo }
  | { type: "todo:renamed"; rev: number; todo: Todo }
  | { type: "todo:moved"; rev: number; todo: Todo }
  | { type: "reset"; rev: number };

export interface CreateProjectRequest {
  title: string;
}

export interface RenameProjectRequest {
  title: string;
}

export interface CreateTodoRequest {
  id: string;
  title: string;
  beforeId?: string | null;
  afterId?: string | null;
}

export interface RenameTodoRequest {
  title: string;
}

export interface MoveTodoRequest {
  toStatus: Status;
  beforeId?: string | null;
  afterId?: string | null;
}

export function isStatus(value: unknown): value is Status {
  return (
    typeof value === "string" &&
    (STATUSES as readonly string[]).includes(value)
  );
}

/** Trim, collapse newlines, enforce length. Returns null when invalid. */
export function normalizeTitle(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const title = input.replace(/[\r\n]+/g, " ").trim().replace(/\s{2,}/g, " ");
  if (title.length === 0 || title.length > max) return null;
  return title;
}

/** Client-generated todo ids: short url-safe strings. */
export function normalizeTodoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > TODO_ID_MAX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  return input;
}

export function normalizeNeighborId(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  return normalizeTodoId(input);
}
