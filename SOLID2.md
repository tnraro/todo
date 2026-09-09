# Solid 2.0 — Research Notes

Researched: 2026-09-09. Status at that time: Release Candidate (`solid-js@2.0.0-rc.6`,
2026-09-02). APIs may still change before stable. Preview docs: https://v2.solidjs.com.
For Solid 1.x, see the stable docs at https://docs.solidjs.com.

## 0. Why It Matters for This Project

Solid 2.0 keeps the 1.x strengths that motivated the stack choice (fine-grained
reactivity with no virtual DOM, ~7KB runtime, deterministic per-card updates) and adds
exactly what a real-time optimistic kanban needs: first-class async in the reactive
graph, built-in optimistic state primitives, and a Rust-based compiler toolchain.
The main cost is RC-stage instability and an ecosystem still migrating.

## 1. Release Status and Getting Started

- Coordinated RC of the whole platform: core library, rendering, routing, head
  management, and the Vite plugin ship together with matching versions. Packages from
  the RC must use compatible versions; do not mix 1.x and 2.0 packages.
- New projects: `npm create solid@latest`, then choose a Solid 2.0 template.
- Existing 1.x projects: official 1.x migration guide plus a 2.0 RFC series explaining
  the design rationale.
- Skipped the planned Alpha phase after a long Experimental stage; Beta arrived
  ~April–May 2026, RC in August 2026.
- If you run SolidStart in production, nothing breaks: it keeps receiving maintenance
  releases. But all new work targets Start mode (see section 9).

## 2. Architecture: Package Split

The monolith is split by responsibility:

| Package | Role |
| ------- | ---- |
| `@solidjs/signals` | Reactive core (signals, memos, effects) |
| `@solidjs/web` | DOM renderer / web runtime (`render`, `dynamic`, `reload`, `isServer`) |
| `solid-js` | Components, stores, and remaining framework APIs |

Practical consequence: `isServer` moved from `solid-js/web` to `@solidjs/web`,
and every dependency must bump `solid-js` and `@solidjs/web` together.

## 3. Reactivity: Async Is Part of the Graph

The headline change: async is no longer something that happens *to* a synchronous
core. Promises and async state live inside the reactive graph, so derived state,
error handling, transitions, and optimistic updates fall out of one model.

Consequences:

- **Microtask batching.** Writes stage a new value and notify subscribers; Solid drains
  pending work in one update pass on the microtask queue. Old content stays visible
  while the new answer is in flight instead of tearing the layout.
- **Stale reads.** A synchronous read right after a write returns the staged (old)
  value. Two escape hatches exist: `latest(signal)` forces synchronous resolution of
  one source, `flush()` resolves everything currently batched.

  ```js
  const [count, setCount] = createSignal(0);
  setCount(1);
  count();         // 0 (staged, not yet flushed)
  latest(count);   // 1
  flush();
  count();         // 1
  ```

- **Split effects.** `createEffect(compute, apply)` separates subscription from side
  effect, because the compute phase may need to wait for the next resolution while the
  subscription must be known now. Single source: `createEffect(signalB, apiCallA)`.
  Multiple sources use a tuple reader.
- **Pending as an expression.** `isPending(() => [memo1, signal2])` reports whether a
  *specific* new answer is on the way — not "is anything fetching anywhere". This
  gives per-card pending UI instead of global spinners.
- **Derived signals.** `createSignal(fn)` and `createStore(fn)` create writable derived
  state directly; `createProjection` is the store equivalent of `createMemo`.
- Component bodies run untracked. Reading a reactive value at the top level of a
  component is a one-time snapshot and produces a dev warning; use JSX, a memo, or an
  effect instead.

## 4. Async Data: Memos, Boundaries, Actions

- **Async memos replace resources.** Feed a Promise or async generator to `createMemo`
  inside a `<Loading>` boundary; it behaves like a sync memo with the initial
  `undefined` swallowed by the boundary. `createResource` is gone.

  ```js
  // 1.x
  const [data] = createResource(() => fetchUser(userId()));
  // 2.0
  const data = createMemo(() => fetchUser(userId())); // inside <Loading>
  ```

- **Boundaries renamed and rescoped.** `<Suspense>` becomes `<Loading>` (holds rendering
  only until the *first* async load); `<SuspenseList>` becomes `<Reveal>`.
- **Optimistic updates are primitives.** `createOptimistic` / `createOptimisticStore`
  plus `action()` express local update, server write, and revalidation as one flow:

  ```js
  const [messages, setMessages] = createOptimistic(() => chatServer.loadMessages());
  const sendMessage = action(function* (next) {
    setMessages((m) => [...m, next]); // local, instant
    yield chatServer.sendMessage(next); // server write
    refresh(messages); // reconcile with server truth
  });
  ```

  This maps 1:1 onto this project's "optimistic UI, server echo is truth" rule.

## 5. Stores

- **Draft-style setters.** Store setters now hand you a mutable draft; `produce` and
  `createMutable` are removed.

  ```js
  // 1.x
  setState("todos", id, "done", true);
  // 2.0
  setState((x) => { x.todos[id].done = true; });
  setState(storePath("todos", id, "done", true)); // old path style still available
  ```

- **Keyed reconcile.** `reconcile(nextTodos, "id")` detects moved items by stable key,
  which is faster for reordered lists than the old always-on behavior.
- **`unwrap(store)` renamed to `snapshot(store)`.**

## 6. Components and JSX

- Props stay reactive via getters until read. Destructuring reactive props (including in
  the parameter list) captures a snapshot and warns in dev. Keep the `props` object
  intact or derive with `createMemo`.
- `createContext` returns the provider itself: `<Theme value="dark">` instead of
  `<Theme.Provider value="dark">`. `useContext` throws when no provider is found, so it
  returns `T`, never `T | undefined`.
- `use:` directives are removed; use ref factories instead (`ref` also accepts an array
  of ref callbacks). `dynamic()` (from `@solidjs/web`) is the canonical API for picking
  a component or element from a reactive source.
- `<Index>` is merged into `<For keyed={false}>`.
- `mergeProps` / `splitProps` become `merge` / `omit`.
- `classList` is removed; `class` now accepts strings, arrays, and objects.
- The `/*@once*/` pragma is removed; use `untrack`.
- Ships LLM-oriented documentation so agentic coding assistants produce correct Solid
  code instead of React-shaped approximations.

## 7. Removed / Renamed API Map (1.x to 2.0)

| 1.x | 2.0 |
| --- | --- |
| `createResource` | async `createMemo` inside `<Loading>` |
| `<Suspense>` | `<Loading>` (first load only) |
| `<SuspenseList>` | `<Reveal>` |
| `produce`, `createMutable` | draft-style store setters |
| `unwrap` | `snapshot` |
| `mergeProps` / `splitProps` | `merge` / `omit` |
| `classList` | `class` (string, array, object) |
| `use:` directives | ref factories |
| `<Index>` | `<For keyed={false}>` |
| `onMount` | `onSettled` (returned function is cleanup) |
| `/*@once*/` pragma | `untrack` |
| Context `.Provider` | context object used directly as component |
| `isServer` from `solid-js/web` | `isServer` from `@solidjs/web` |

## 8. Tooling

- New compiler toolchain in Rust on top of Oxc. `@solidjs/vite-plugin` uses it by
  default with zero configuration; the Babel preset remains as an option.
- Server functions use a directive boundary as the privacy mechanism: anything
  referenced only inside the body never reaches the client. `reload` (from
  `@solidjs/web`) revalidates server data.
- Pull-based run-once SSR replaces the old streaming model.

## 9. SolidStart Retired, Start Mode Instead

SolidStart as a separate metaframework is retired; "Start mode" replaces it. Rationale
given by the team: after the 2.0 simplifications, a standalone framework was a wrapper
around things that no longer needed wrapping. SolidStart keeps maintenance releases,
and a migration guide exists. For this project the point is moot: the Bun server
serves the built app directly, so no metaframework is involved either way.

## 10. Ecosystem Readiness (as of 2026-09-09)

- **TanStack** (Router, Start, Query) ships Solid 2.0 beta support. Not needed here
  (single view, no router, no server-state cache beyond the SSE stream).
- **Solid Primitives 2.0** is in pre-release under the `next` tag and requires
  `solid-js@^2.0.0-rc.0` + `@solidjs/web@^2.0.0-rc.0` as peers. Five packages are still
  1.x-only with no 2.0 path yet: `fetch`, `immutable`, `db-store`, `graphql`,
  `resource`. None of them is on this project's dependency path.
- `@solidjs/testing-library` works via the `next` branch; `storybook-solid` has early
  working versions.
- Community support channel is the Solid Discord.

## 11. Implications for This Project

- **Optimistic UI:** manual optimistic updates over a todo array with pending flags
  and rollback, reconciled by the SSE server echo. `createOptimisticStore` +
  `action()` were evaluated, but `refresh()`-based revalidation duplicates what
  the SSE echo already does, so the thinner manual path won (fewer RC API
  surface, same UX).
- **SSE stream:** consume events into signals; derive per-column lists with memos
  (`createSignal(fn)` / `createProjection` keyed by todo id). Per-card updates stay
  fine-grained, which is Solid's core strength.
- **Pending states:** `isPending` on the moved/renamed todo gives the pending mark
  without global loading flags.
- **Rank healing:** server already heals bad `beforeId/afterId`; client reconciliation
  is `reconcile(list, "id")`, which also handles reorder cheaply.
- **No router, no data-fetching library, no store library, no DnD library.** The
  framework plus native DnD covers the whole design. Keep it that way (YAGNI).
- **No SolidStart / Start mode.** Bun serves static + REST + SSE from one process.

## 12. Risks

- **RC churn.** APIs may still change before stable. Pin exact RC versions across
  `solid-js`, `@solidjs/web`, and the Vite plugin; re-check the migration guide before
  upgrading.
- **Stale-read mental model.** Writes no longer read back synchronously. Event
  handlers that read-then-write in one tick must use `latest()` or restructure into
  derivations. This is the most likely source of subtle kanban bugs (e.g. computing a
  drop position from an unflushed list).
- **Split-effect verbosity.** Effects now declare subscriptions explicitly, which is
  more ceremony for conditional tracking patterns. Prefer memos and derivations so
  effects are rarely needed at all.
- **Ecosystem gaps.** Anything Needed from the five unmigrated primitives (or other
  1.x-only libraries) blocks adoption of that piece. Current design needs none of
  them, but verify before adding a dependency.
- **Test tooling is pre-release.** Testing-library tracks `next`; expect rough edges
  in component tests.

## Sources

- Solid 2.0 RC announcement ("The Big <Reveal>", 2026-08-13):
  https://www.solidjs.com/blog/solid-2-0-rc-the-big-reveal
- Solid 2.0 preview docs (RC): https://v2.solidjs.com
- Reactivity concept reference: https://v2.solidjs.com/concepts/reactivity
- "What is new in solid-js@2.0?" (A. Lohr, 2026-06): 
  https://dev.to/lexlohr/what-is-new-in-solid-js20-11hk
- SolidJS 2.0 Beta overview (InfoQ, 2026-05):
  https://www.infoq.com/news/2026/05/solidjs-2-async
- TanStack Solid 2.0 beta support (2026-04): https://tanstack.com/blog/tanstack-start-solid-v2
- Solid Primitives 2 migration guide: https://primitives2.solidjs.community/migration
- Release history: https://github.com/solidjs/solid/releases
