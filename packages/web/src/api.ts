// REST + SSE client. Thin by design: no merge logic here, the server is truth.
// Rev ordering and snapshot fallback live in the board wiring (App.tsx).
import type {
  Project,
  ServerEvent,
  Snapshot,
  Status,
  Todo,
} from "@todo/shared";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as any).error ?? `request failed: ${res.status}`);
  }
  return data as T;
}

export function createProject(title: string): Promise<{ id: string; title: string }> {
  return call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function fetchSnapshot(projectId: string): Promise<Snapshot> {
  return call(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function renameProject(
  projectId: string,
  title: string,
): Promise<{ project: Project; rev: number }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export interface NewTodo {
  id: string;
  title: string;
  beforeId?: string | null;
  afterId?: string | null;
}

export function createTodo(
  projectId: string,
  todo: NewTodo,
): Promise<{ todo: Todo; rev: number }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/todos`, {
    method: "POST",
    body: JSON.stringify(todo),
  });
}

export function renameTodo(
  projectId: string,
  todoId: string,
  title: string,
): Promise<{ todo: Todo; rev: number }> {
  return call(
    `/api/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}`,
    { method: "PATCH", body: JSON.stringify({ title }) },
  );
}

export function moveTodo(
  projectId: string,
  todoId: string,
  toStatus: Status,
  beforeId: string | null,
  afterId: string | null,
): Promise<{ todo: Todo; rev: number }> {
  return call(
    `/api/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ toStatus, beforeId, afterId }),
    },
  );
}

/** Hard delete. The server only deletes archived todos. */
export function deleteTodo(
  projectId: string,
  todoId: string,
): Promise<{ rev: number }> {
  return call(
    `/api/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}`,
    { method: "DELETE" },
  );
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Client-generated todo id: 12 url-safe chars, also used for idempotent retry. */
export function genTodoId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const b of bytes) id += ID_CHARS[b & 63];
  return id;
}

export interface StreamHandlers {
  onEvent: (event: ServerEvent) => void;
  onOpen: () => void;
  onError: () => void;
}

/**
 * SSE subscription. EventSource auto-reconnects and resends Last-Event-ID;
 * the server replays missed events or emits `reset` when the gap is too old.
 */
export function subscribe(
  projectId: string,
  sinceRev: number,
  handlers: StreamHandlers,
): () => void {
  const source = new EventSource(
    `/api/projects/${encodeURIComponent(projectId)}/events?sinceRev=${sinceRev}`,
  );
  source.onopen = () => handlers.onOpen();
  source.onerror = () => handlers.onError();
  source.onmessage = (message) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as ServerEvent);
    } catch {
      // Ignore malformed frames; the rev gap check refetches if we fall behind.
    }
  };
  return () => source.close();
}
