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

1. Fork and branch from `main` (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`).
2. Keep PRs focused; add or update tests, including failure paths.
3. Run `pnpm smoke` if you touched `package.json`, exports, or the build: it packs the library and installs it into an empty project.
4. Make sure `pnpm build` and `pnpm test` pass, and that the number of tests run is what you expect.
5. **Title the PR `type: summary`** (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`; `feat!:` for breaking changes). The squash-merge uses this title, and it is what generates the version bump and changelog, so it matters.

Maintainers merge with *Squash and merge*. See [MAINTAINING.md](MAINTAINING.md) for how reviews and releases work.

## Writing a connector

`src/connectors/github` is the reference. Put a new connector in `src/connectors/<name>/index.ts` (tests next to it) and add a `./<name>` entry to `exports` in `package.json`; `pnpm smoke` will tell you if it doesn't install correctly. A good connector PR:

- [ ] Declares each action with a `description` written for an LLM ("Use when..."), strict Zod `input`/`output`, and the right `effect` (`read`, `write`, `destructive`).
- [ ] Marks a write `safeToRetry: true` **only** if repeating it cannot change the outcome (idempotent); otherwise leaves it unset.
- [ ] Uses a provider pagination strategy from core (`linkHeaderPagination`, `bodyCursorPagination`, or a new reusable one) rather than hand-rolled paging; paginated actions declare optional `cursor` and `pageSize` inputs.
- [ ] If the API reports failures inside a 200 response, implements `detectError` (see Slack) so retries and token refresh still work.
- [ ] Has tests with a fake `fetch`: success, `404`, `429`, a malformed response, and bad input.
- [ ] Has an opt-in live test (skipped without a token) if the API is public enough to try.
- [ ] Keeps the connector small: if you need hand-written HTTP logic, say why in the PR.
