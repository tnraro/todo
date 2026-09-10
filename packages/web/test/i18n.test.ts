// i18n tests. The parity test imports the source module directly (no DOM);
// the toggle test drives the built harness under happy-dom like the focus
// tests. Run via `bun run test:web`.
import { afterAll, describe, expect, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { initDom, snapshot, waitFor } from "./setup";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("dictionaries", () => {
  test("ko has exactly en's keys, all non-empty", () => {
    expect(keys(dictionaries.ko).sort()).toEqual(keys(dictionaries.en).sort());
    for (const key of keys(dictionaries.ko)) {
      const value = key
        .split(".")
        .reduce<unknown>(
          (o, k) => (o as Record<string, unknown>)[k],
          dictionaries.ko,
        );
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });
});

const window = initDom("http://localhost/p/test123");

describe("locale toggle", () => {
  test("switches UI text and persists", async () => {
    const { mountApp, settle } = await import("../dist-test/harness.js");
    await mountApp(snapshot);
    await settle();

    const head = () =>
      document.querySelector(".columns .column .column-head")?.textContent;
    expect(head()).toMatch("Todo");

    // Topbar: home link left, centered title, actions right.
    const bar = document.querySelector(".topbar")!;
    const cells = [...bar.childNodes]
      .filter((n) => n.nodeType === 1)
      .map((n) => (n as HTMLElement).tagName);
    expect(cells).toEqual(["A", "BUTTON", "DIV"]);
    const home = bar.querySelector("a.home-link") as HTMLAnchorElement;
    // happy-dom does not reflect the href property back to the attribute,
    // so assert the resolved property instead of getAttribute.
    expect(new URL(home.href).pathname).toBe("/");
    expect(
      (bar.querySelector(".topbar-actions") as HTMLElement).textContent,
    ).toMatch("Copy link");

    const toggle = () =>
      document.querySelector(".locale-toggle") as HTMLElement;
    expect(toggle().textContent).toBe("KO");
    toggle().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await waitFor(1000, () =>
      head()?.includes("할 일") ? document.body : null,
    );
    expect(head()).toMatch("할 일");
    expect(document.documentElement.lang).toBe("ko");
    expect(localStorage.getItem("todo.locale")).toBe("ko");
    expect(toggle().textContent).toBe("EN");

    // Back to English.
    toggle().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(1000, () => (head()?.includes("Todo") ? document.body : null));
    expect(head()).toMatch("Todo");
    expect(document.documentElement.lang).toBe("en");
  });
});

afterAll(async () => {
  await window.happyDOM.close();
});
