// Unit tests for fractional rank keys and project id generation.
import { describe, expect, test } from "bun:test";
import { firstRank, generateProjectId, keyBetween } from "@todo/shared";

function between(a: string | null, b: string | null): string {
  const k = keyBetween(a, b);
  if (a !== null) expect(k > a).toBe(true);
  if (b !== null) expect(k < b).toBe(true);
  expect(k).toMatch(/^\d+$/);
  expect(k.endsWith("0")).toBe(false);
  return k;
}

describe("keyBetween", () => {
  test("empty column starts at 5", () => {
    expect(keyBetween(null, null)).toBe("5");
    expect(firstRank()).toBe("5");
  });

  test("open ends step outward", () => {
    expect(between(null, "5") < "5").toBe(true);
    expect(between("5", null) > "5").toBe(true);
  });

  test("adjacent digits split", () => {
    const k = between("5", "6");
    expect(k > "5" && k < "6").toBe(true);
  });

  test("deep adjacency terminates", () => {
    // Squeeze between 29 and 3 repeatedly; keys must stay strictly ordered.
    let lo = "29";
    const hi = "3";
    for (let n = 0; n < 50; n++) {
      lo = between(lo, hi);
    }
    expect(lo < hi).toBe(true);
  });

  test("repeated top inserts stay ordered and compact", () => {
    let top = "5";
    let longest = 0;
    for (let n = 0; n < 200; n++) {
      top = between(null, top);
      longest = Math.max(longest, top.length);
    }
    expect(longest).toBeLessThan(120);
  });

  test("repeated bottom inserts stay ordered and compact", () => {
    let bottom = "5";
    let longest = 0;
    for (let n = 0; n < 200; n++) {
      bottom = between(bottom, null);
      longest = Math.max(longest, bottom.length);
    }
    expect(longest).toBeLessThan(120);
  });

  test("random insertions preserve list order", () => {
    // Simulate a column: insert ids at random positions, rank each insert
    // between its new neighbors, then verify rank sort == list order.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ids: string[] = [];
    const ranks = new Map<string, string>();
    for (let n = 0; n < 300; n++) {
      const id = `t${n}`;
      const pos = Math.floor(rand() * (ids.length + 1));
      ids.splice(pos, 0, id);
      const before = pos === 0 ? null : (ranks.get(ids[pos - 1]) ?? null);
      const after =
        pos === ids.length - 1 ? null : (ranks.get(ids[pos + 1]) ?? null);
      ranks.set(id, between(before, after));
    }
    const byRank = [...ids].sort((x, y) =>
      ranks.get(x)! < ranks.get(y)! ? -1 : 1,
    );
    expect(byRank).toEqual(ids);
    expect(new Set(ranks.values()).size).toBe(ids.length);
  });
});

describe("generateProjectId", () => {
  test("22 url-safe chars, unique", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const id = generateProjectId();
      expect(id).toMatch(/^[A-Za-z0-9\-_]{22}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});
