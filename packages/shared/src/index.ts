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

// --- Fractional order keys -------------------------------------------------
// A rank is a non-empty string of decimal digits. Read it as the fractional
// part of "0.<rank>": lexicographic (byte) order equals numeric order, so any
// store can ORDER BY rank directly. Only the server generates ranks;
// generated keys never end in "0", which keeps the invariant airtight.

/**
 * Return a rank strictly between a and b (null = open end).
 * Any key strictly between the neighbors works for ordering; this returns a
 * short midpoint so keys stay compact under repeated inserts.
 */
export function keyBetween(a: string | null, b: string | null): string {
  let A = a ?? "";
  let B = b ?? "";
  let head = "";
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) {
    head += A[i];
    i++;
  }
  A = A.slice(i);
  B = B.slice(i);

  if (A === "" && B === "") return head + "5";

  if (B === "") {
    // No upper bound: step above A.
    const digits = A.split("");
    let j = digits.length - 1;
    while (j >= 0 && digits[j] === "9") j--;
    if (j < 0) return head + A + "5";
    return head + digits.slice(0, j).join("") + String(Number(digits[j]) + 1);
  }

  if (A === "") {
    // No lower bound (or a equals the shared head): step below B.
    let k = 0;
    while (B[k] === "0") {
      head += "0";
      k++;
    }
    if (k >= B.length) throw new Error("rank underflow: no key below zero");
    return head + String(Number(B[k]) - 1) + "5";
  }

  const x = Number(A[0]);
  const y = Number(B[0]);
  if (y - x > 1) return head + String(x + ((y - x) >> 1));
  return head + A[0] + keyBetween(A.slice(1) || null, B.slice(1) || null);
}

/** Rank for the first todo in an empty column. */
export function firstRank(): string {
  return keyBetween(null, null);
}

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unguessable project id: 22 url-safe chars, 132 bits of entropy. */
export function generateProjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let id = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6 && id.length < 22) {
      bits -= 6;
      id += ID_ALPHABET[(acc >> bits) & 63];
    }
    acc &= (1 << bits) - 1;
  }
  return id;
}
