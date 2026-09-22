# Contributing

Thanks for your interest. The project is pre-0.1, so the design is still moving. Open an issue before large changes.

## Ground rules

- **Decisions are recorded.** Significant design changes need an ADR in `docs/adr/` (copy `0000-template.md`).
- **The core knows nothing about agents; adapters know nothing about specific providers.** Every call goes through `execute`.
- **Never log or return secrets.** Tokens must not appear in logs, errors or tool output.
- **Test failure paths,** not just the happy path (expired tokens, 429s, 5xx on writes, malformed responses).

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Pull requests

1. Fork and branch from `main`.
2. Keep PRs focused; add or update tests.
3. Update `CHANGELOG.md` under "Unreleased".
4. Make sure `pnpm typecheck` and `pnpm test` pass.

## Writing a connector

Connector authoring docs will land with v0.1. Until then, `packages/connector-github` is the reference.
