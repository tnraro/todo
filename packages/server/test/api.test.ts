// HTTP integration tests: REST contract, ordering, LWW revs, SSE stream.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/index";
import { openDb } from "../src/db";
import { EventHub } from "../src/events";
import type { Snapshot, Todo } from "@todo/shared";

let base = "";
let stop: () => void = () => {};

beforeAll(() => {
  const app = createApp(openDb(":memory:"), { distDir: null });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  stop = () => server.stop(true);
});

afterAll(() => stop());

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

function todosByStatus(snap: Snapshot, status: Todo["status"]): Todo[] {
  return snap.todos
    .filter((t) => t.status === status)
    .sort((a, b) => (a.rank < b.rank ? -1 : 1));
}

describe("projects", () => {
  test("create, snapshot, rename, 404, validation", async () => {
    const created = await req("POST", "/api/projects", { title: "  Shop " });
    expect(created.status).toBe(201);
    expect(created.data.id).toMatch(/^[A-Za-z0-9\-_]{22}$/);
    expect(created.data.title).toBe("Shop");
    const id = created.data.id as string;

    const snap = await req("GET", `/api/projects/${id}`);
    expect(snap.status).toBe(200);
    expect(snap.data.project).toEqual({ id, title: "Shop" });
    expect(snap.data.todos).toEqual([]);
    expect(snap.data.rev).toBe(0);

    const renamed = await req("PATCH", `/api/projects/${id}`, {
      title: "Shop v2",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.data.rev).toBe(1);

    expect((await req("GET", "/api/projects/nope")).status).toBe(404);
    expect(
      (await req("PATCH", "/api/projects/nope", { title: "x" })).status,
    ).toBe(404);
    expect((await req("POST", "/api/projects", { title: "  " })).status).toBe(
      400,
    );
    expect(
      (await req("POST", "/api/projects", { title: "x".repeat(101) })).status,
    ).toBe(400);
  });
});

describe("todos", () => {
  test("create defaults to top, rename, move, heal, idempotency", async () => {
    const { data } = await req("POST", "/api/projects", { title: "P" });
    const pid = data.id as string;
    const url = `/api/projects/${pid}/todos`;

    const mk = async (id: string, extra: object = {}) => {
      const r = await req("POST", url, { id, title: id, ...extra });
      expect(r.status).toBe(201);
      return r.data.todo as Todo;
    };

    const a = await mk("a");
    const b = await mk("b");
    const c = await mk("c");
    // Each create goes to the top: newest first.
    let snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(todosByStatus(snap, "todo").map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(snap.rev).toBe(3);

    // Rename bumps rev, keeps rank.
    const renamed = await req("PATCH", `${url}/a`, { title: "A!" });
    expect(renamed.status).toBe(200);
    expect(renamed.data.todo.title).toBe("A!");
    expect(renamed.data.todo.rank).toBe(a.rank);
    expect(renamed.data.rev).toBe(4);

    // Move a to top with no neighbors (both open = top).
    const moved = await req("POST", `${url}/a/move`, { toStatus: "todo" });
    expect(moved.status).toBe(200);
    snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(todosByStatus(snap, "todo").map((t) => t.id)).toEqual(["a", "c", "b"]);

    // Move b between a and c via explicit neighbors.
    const ids = todosByStatus(snap, "todo").map((t) => t.id);
    expect(ids).toEqual(["a", "c", "b"]);
    const between = await req("POST", `${url}/b/move`, {
      toStatus: "todo",
      beforeId: "a",
      afterId: "c",
    });
    expect(between.status).toBe(200);
    snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(todosByStatus(snap, "todo").map((t) => t.id)).toEqual(["a", "b", "c"]);

    // Unknown neighbors heal instead of erroring.
    const healed = await req("POST", `${url}/b/move`, {
      toStatus: "doing",
      beforeId: "ghost",
      afterId: "also-ghost",
    });
    expect(healed.status).toBe(200);
    expect(healed.data.todo.status).toBe("doing");
    snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(todosByStatus(snap, "doing").map((t) => t.id)).toEqual(["b"]);

    // Idempotent re-create returns the existing todo without a rev bump.
    const revBefore = snap.rev;
    const again = await req("POST", url, { id: "a", title: "changed?" });
    expect(again.status).toBe(200);
    expect(again.data.todo.title).toBe("A!");
    expect(again.data.rev).toBe(revBefore);

    // Same todo id in another project conflicts.
    const other = await req("POST", "/api/projects", { title: "Q" });
    const clash = await req("POST", `/api/projects/${other.data.id}/todos`, {
      id: "a",
      title: "clash",
    });
    expect(clash.status).toBe(409);

    // Errors: unknown todo, bad status, bad title, bad id.
    expect((await req("PATCH", `${url}/ghost`, { title: "x" })).status).toBe(404);
    expect(
      (await req("POST", `${url}/a/move`, { toStatus: "nope" })).status,
    ).toBe(400);
    expect((await req("POST", url, { id: "z", title: "" })).status).toBe(400);
    expect((await req("POST", url, { id: "!!!", title: "z" })).status).toBe(400);
  });
});

describe("delete", () => {
  test("archive-only hard delete with rev and snapshot", async () => {
    const { data } = await req("POST", "/api/projects", { title: "D" });
    const pid = data.id as string;
    const url = `/api/projects/${pid}/todos`;

    await req("POST", url, { id: "gone", title: "gone" });
    await req("POST", url, { id: "stays", title: "stays" });

    // Active todos cannot be hard deleted.
    const refused = await req("DELETE", `${url}/gone`);
    expect(refused.status).toBe(409);
    let snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(snap.todos.some((t) => t.id === "gone")).toBe(true);

    // Archive, then delete.
    await req("POST", `${url}/gone/move`, { toStatus: "archive" });
    const revBefore = (await req("GET", `/api/projects/${pid}`)).data.rev as number;
    const deleted = await req("DELETE", `${url}/gone`);
    expect(deleted.status).toBe(200);
    expect(deleted.data.rev).toBe(revBefore + 1);

    snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;
    expect(snap.todos.map((t) => t.id)).toEqual(["stays"]);
    expect(snap.rev).toBe(revBefore + 1);

    // Repeating, unknown todos, and unknown projects 404.
    expect((await req("DELETE", `${url}/gone`)).status).toBe(404);
    expect((await req("DELETE", `${url}/ghost`)).status).toBe(404);
    expect((await req("DELETE", "/api/projects/nope/todos/gone")).status).toBe(404);

    // The id is free again after deletion.
    const recreated = await req("POST", url, { id: "gone", title: "again" });
    expect(recreated.status).toBe(201);
  });

  test("todo:deleted arrives on the stream", async () => {
    const { data } = await req("POST", "/api/projects", { title: "E" });
    const pid = data.id as string;
    const url = `/api/projects/${pid}/todos`;
    await req("POST", url, { id: "x", title: "x" });
    await req("POST", `${url}/x/move`, { toStatus: "archive" });
    const snap = (await req("GET", `/api/projects/${pid}`)).data as Snapshot;

    const liveP = fetch(`${base}/api/projects/${pid}/events?sinceRev=${snap.rev}`);
    await new Promise((r) => setTimeout(r, 150));
    const deleted = await req("DELETE", `${url}/x`);
    const live = await liveP;
    expect(live.status).toBe(200);
    const reader = live.body!.getReader();
    try {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"type":"todo:deleted"');
      expect(text).toContain(`"rev":${deleted.data.rev}`);
      expect(text).toContain('"todoId":"x"');
    } finally {
      await reader.cancel();
    }
  });
});

describe("sse", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** First frame of a stream, then close. Never use res.text(): streams stay open. */
  async function firstFrame(res: Response): Promise<string> {
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      return new TextDecoder().decode(value);
    } finally {
      await reader.cancel();
    }
  }

  test("delivers live events", async () => {
    const { data } = await req("POST", "/api/projects", { title: "S" });
    const pid = data.id as string;
    const rev0 = (await req("GET", `/api/projects/${pid}`)).data.rev as number;

    // Do NOT await the stream before mutating: the fetch settles only once
    // the first bytes arrive, which is the mutation below. Either interleaving
    // converges: live delivery if subscribed in time, ring replay otherwise.
    const liveP = fetch(`${base}/api/projects/${pid}/events?sinceRev=${rev0}`);
    await sleep(150);
    const renamed = await req("PATCH", `/api/projects/${pid}`, {
      title: "S2",
    });
    const frame = await firstFrame(await liveP);
    expect(frame).toContain('"type":"project:renamed"');
    expect(frame).toContain(`"rev":${renamed.data.rev}`);
  });

  test("replays missed events", async () => {
    const { data } = await req("POST", "/api/projects", { title: "T" });
    const pid = data.id as string;
    const created = await req("POST", `/api/projects/${pid}/todos`, {
      id: "t1",
      title: "t1",
    });
    const frame = await firstFrame(
      await fetch(`${base}/api/projects/${pid}/events?sinceRev=0`),
    );
    expect(frame).toContain('"type":"todo:created"');
    expect(frame).toContain(`"rev":${created.data.rev}`);
  });

  test("ignores future sinceRev until the next event", async () => {
    const { data } = await req("POST", "/api/projects", { title: "F" });
    const pid = data.id as string;
    const liveP = fetch(`${base}/api/projects/${pid}/events?sinceRev=999`);
    await sleep(150);
    const renamed = await req("PATCH", `/api/projects/${pid}`, {
      title: "F2",
    });
    const frame = await firstFrame(await liveP);
    expect(frame).not.toContain('"type":"reset"');
    expect(frame).toContain('"type":"project:renamed"');
    expect(frame).toContain(`"rev":${renamed.data.rev}`);
  });

  test("resets on unrecoverable gap", async () => {
    const db = openDb(":memory:");
    const app = createApp(db, { hub: new EventHub(), distDir: null });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const local = `http://localhost:${server.port}`;
    try {
      const created = await fetch(local + "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "G" }),
      }).then((r) => r.json());
      // One mutation fills the ring; overflow it with 101 more.
      for (let n = 0; n < 101; n++) {
        await fetch(local + `/api/projects/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: `G${n}` }),
        });
      }
      const res = await fetch(
        local + `/api/projects/${created.id}/events?sinceRev=0`,
      );
      expect(await firstFrame(res)).toContain('"type":"reset"');
    } finally {
      server.stop(true);
    }
  });
});
