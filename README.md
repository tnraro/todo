# todo

Anonymous realtime kanban. No signup — anyone with the link can read and edit.

## Stack

- Frontend: SolidJS 2.0 (Vite)
- Backend: Bun + SQLite (`bun:sqlite`), REST + SSE
- Local-first: IndexedDB cache + outbox sync, server stays the authority
  (per-project `rev`, last-writer-wins)

## Run

```sh
bun install
bun run dev        # server :3001 + web :5173 (proxies /api)
```

```sh
bun run build      # → packages/web/dist
bun run start      # serves dist + API on :3001
```

```sh
docker build -t todo .
docker compose up --build -d   # :3001, data in todo-data volume
```

| Env | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3001` | HTTP port |
| `TODO_DB` | `data/app.db` | SQLite path (`:memory:` for ephemeral) |
| `WEB_DIST` | `packages/web/dist` | Static dir (auto-detected) |
| `TRUST_PROXY` | off | `1` trusts `X-Forwarded-For` for rate limiting (reverse proxy deployments) |

## Layout

```
packages/
  shared/  types + validation (single source of truth)
  server/  API, SSE, SQLite store, prod static
  web/     SolidJS app (api client, kanban UI, sync engine)
```

## Verify

```sh
bun run test             # server + web suites
bun run test:server      # REST, ordering, SSE, log, static
bun run test:web         # DOM suite (one process per test file)
bun run typecheck
```

Run `bun run test` (or the scoped scripts). A bare `bun test` at the repo root
must not be used: the web harness stubs global `fetch`/`window`, which breaks
the server suite.

Design details live in `DESIGN.md`.
