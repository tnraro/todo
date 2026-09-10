Follow the DRY, KISS, YAGNI, and SOLID principles in code.

Use clear and concise English in documents, comments, or commit messages. Exception: keep proper nouns as-is.

Run `bun run test` for the full suite. Never run a bare `bun test` at the repo root: the web DOM harness stubs global `fetch`/`window` and breaks the server suite. Each web test file must run in its own process (`bun run test:web` handles this).