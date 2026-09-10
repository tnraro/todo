// Sync engine helpers: outbox collapsing (pure, unit-tested) and op sending.
// State application stays in App.tsx; this module never touches signals.
import type { Status } from "@todo/shared";
import {
  createTodo,
  deleteTodo,
  moveTodo,
  renameProject,
  renameTodo,
  type ApiError,
} from "./api";
import type { OutboxOp } from "./store";
import type { Project, Todo } from "@todo/shared";

export interface CollapsedOp {
  op: OutboxOp;
  seqs: number[];
}

/**
 * Collapse queued ops per todo, preserving order across todos:
 * - rename folds into the pending create/rename for the same todo
 * - move replaces the pending move for the same todo
 * - delete supersedes every pending op for the same todo (a create that never
 *   reached the server makes the delete 404, which counts as converged)
 * - projectRename keeps the last title
 * Attempts on the surviving op are the max of the group (poison counting).
 */
export function collapseOps(ops: OutboxOp[]): CollapsedOp[] {
  interface Slot {
    op: OutboxOp;
    seqs: number[];
    dropped: boolean;
  }
  const out: Slot[] = [];
  const byTodo = new Map<string, { create?: number; rename?: number; move?: number }>();
  let projectRename = -1;

  const slotFor = (todoId: string) => {
    let slot = byTodo.get(todoId);
    if (!slot) {
      slot = {};
      byTodo.set(todoId, slot);
    }
    return slot;
  };

  for (const op of ops) {
    const seq = op.seq ?? -1;
    if (op.kind === "projectRename") {
      if (projectRename >= 0) {
        out[projectRename].op = { ...op, attempts: Math.max(out[projectRename].op.attempts, op.attempts) };
        out[projectRename].seqs.push(seq);
      } else {
        projectRename = out.length;
        out.push({ op: { ...op }, seqs: [seq], dropped: false });
      }
      continue;
    }
    const tid = op.todoId ?? "";
    const slot = slotFor(tid);
    if (op.kind === "rename") {
      const target =
        slot.create !== undefined ? slot.create : slot.rename;
      if (target !== undefined) {
        out[target].op = {
          ...out[target].op,
          title: op.title,
          attempts: Math.max(out[target].op.attempts, op.attempts),
        };
        out[target].seqs.push(seq);
      } else {
        slot.rename = out.length;
        out.push({ op: { ...op }, seqs: [seq], dropped: false });
      }
    } else if (op.kind === "move") {
      if (slot.move !== undefined) {
        out[slot.move].op = {
          ...op,
          attempts: Math.max(out[slot.move].op.attempts, op.attempts),
        };
        out[slot.move].seqs.push(seq);
      } else {
        slot.move = out.length;
        out.push({ op: { ...op }, seqs: [seq], dropped: false });
      }
    } else if (op.kind === "delete") {
      // Superseded rows are removed together with the delete on success; on
      // a 409 (todo remotely un-archived) only the delete row is dropped and
      // the survivors are resent after a pull — remote wins the conflict.
      const doomed: number[] = [seq];
      for (const idx of [slot.create, slot.rename, slot.move]) {
        if (idx !== undefined) {
          out[idx].dropped = true;
          doomed.push(...out[idx].seqs);
        }
      }
      byTodo.delete(tid);
      out.push({ op: { ...op }, seqs: doomed, dropped: false });
    } else {
      // create: one live create per todo at most (retries reuse the row).
      slot.create = out.length;
      out.push({ op: { ...op }, seqs: [seq], dropped: false });
    }
  }

  return out
    .filter((slot) => !slot.dropped)
    .map(({ op, seqs }) => ({ op, seqs: [...new Set(seqs)] }));
}

export interface AckResult {
  rev: number;
  todo?: Todo;
  project?: Project;
}

/** Send one collapsed op to the server. Throws ApiError on failure. */
export function sendOp(op: OutboxOp): Promise<AckResult> {
  const pid = op.projectId;
  switch (op.kind) {
    case "create":
      return createTodo(pid, {
        id: op.todoId ?? "",
        title: op.title ?? "",
        beforeId: null,
        afterId: null,
      });
    case "rename":
      return renameTodo(pid, op.todoId ?? "", op.title ?? "");
    case "move":
      return moveTodo(
        pid,
        op.todoId ?? "",
        (op.toStatus ?? "todo") as Status,
        op.beforeId ?? null,
        op.afterId ?? null,
      );
    case "delete":
      return deleteTodo(pid, op.todoId ?? "");
    case "projectRename":
      return renameProject(pid, op.title ?? "");
  }
}

export type { ApiError };
