// Unit tests for outbox collapsing (pure logic, no DOM).
// Run via `bun run test:web`.
import { describe, expect, test } from "bun:test";
import { collapseOps } from "../src/sync";
import type { OutboxOp } from "../src/store";

let seq = 0;
function op(partial: Partial<OutboxOp> & { kind: OutboxOp["kind"] }): OutboxOp {
  return {
    seq: ++seq,
    projectId: "p",
    attempts: 0,
    createdAt: 0,
    ...partial,
  };
}

describe("collapseOps", () => {
  test("rename folds into pending create and rename", () => {
    const groups = collapseOps([
      op({ kind: "create", todoId: "a", title: "a" }),
      op({ kind: "rename", todoId: "a", title: "a2" }),
      op({ kind: "rename", todoId: "a", title: "a3" }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].op.kind).toBe("create");
    expect(groups[0].op.title).toBe("a3");
    expect(groups[0].seqs.length).toBe(3);
  });

  test("move replaces pending move, keeps order across todos", () => {
    const groups = collapseOps([
      op({ kind: "move", todoId: "a", toStatus: "doing", beforeId: null, afterId: null }),
      op({ kind: "rename", todoId: "b", title: "b!" }),
      op({ kind: "move", todoId: "a", toStatus: "done", beforeId: null, afterId: null }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0].op.kind).toBe("move");
    expect(groups[0].op.toStatus).toBe("done");
    expect(groups[0].seqs.length).toBe(2);
    expect(groups[1].op.todoId).toBe("b");
  });

  test("rename after move appends separately", () => {
    const groups = collapseOps([
      op({ kind: "move", todoId: "a", toStatus: "doing", beforeId: null, afterId: null }),
      op({ kind: "rename", todoId: "a", title: "x" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.op.kind)).toEqual(["move", "rename"]);
  });

  test("delete supersedes pending ops for the todo", () => {
    const groups = collapseOps([
      op({ kind: "create", todoId: "a", title: "a" }),
      op({ kind: "rename", todoId: "b", title: "b!" }),
      op({ kind: "rename", todoId: "a", title: "a2" }),
      op({ kind: "delete", todoId: "a" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0].op.todoId).toBe("b");
    expect(groups[1].op.kind).toBe("delete");
    // Create + folded rename + delete rows all removed on success.
    expect(groups[1].seqs.length).toBe(3);
  });

  test("projectRename keeps last title", () => {
    const groups = collapseOps([
      op({ kind: "projectRename", title: "v1" }),
      op({ kind: "rename", todoId: "a", title: "x" }),
      op({ kind: "projectRename", title: "v2" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0].op.kind).toBe("projectRename");
    expect(groups[0].op.title).toBe("v2");
    expect(groups[0].seqs.length).toBe(2);
  });

  test("attempts take the group max", () => {
    const a = op({ kind: "rename", todoId: "a", title: "x" });
    a.attempts = 4;
    const groups = collapseOps([a, op({ kind: "rename", todoId: "a", title: "y" })]);
    expect(groups[0].op.attempts).toBe(4);
  });

  test("move replacement keeps the max attempts", () => {
    const a = op({ kind: "move", todoId: "a", toStatus: "doing" });
    a.attempts = 3;
    const groups = collapseOps([a, op({ kind: "move", todoId: "a", toStatus: "done" })]);
    expect(groups.length).toBe(1);
    expect(groups[0].op.toStatus).toBe("done");
    expect(groups[0].op.attempts).toBe(3);
  });
});
