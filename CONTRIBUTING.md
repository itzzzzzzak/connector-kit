# Contributing to connector-kit

Thank you for helping. connector-kit is a small, security-sensitive library: it holds people's credentials and is driven by AI models that can make mistakes. That shapes how we review changes, and this guide tells you what to expect so your time is well spent.

**Contents:** [Ways to contribute](#ways-to-contribute) · [Before you start](#before-you-start) · [Development setup](#development-setup) · [The development loop](#the-development-loop) · [Contributing a connector](#contributing-a-connector) · [Verifying a connector against a real account](#verifying-a-connector-against-a-real-account) · [Pull requests](#pull-requests) · [Engineering rules](#engineering-rules) · [Using AI tools to contribute](#using-ai-tools-to-contribute) · [Getting help](#getting-help)

## Ways to contribute

In rough order of how much they help:

1. **Run a `docs-based` connector against a real account and report what you find.** Most connectors were written from official API descriptions and have never touched the real service. A wrong field name or scope is invisible to our fake servers and obvious to the first real user. See [verifying a connector](#verifying-a-connector-against-a-real-account).
2. **Add a connector** for a service we do not cover. See [Contributing a connector](#contributing-a-connector).
3. **Report a bug** with a minimal reproduction (redact all tokens).
4. **Improve the docs**, especially anything that confused you when you first used the kit.
5. **Fix a bug or add a core feature.** Please open an issue first (see below).

Security vulnerabilities are the exception: **do not open a public issue or PR.** Follow [SECURITY.md](SECURITY.md).

## Before you start

- **Small fixes** (typos, docs, an obvious bug with a test) can go straight to a PR.
- **Larger changes** (new core behavior, new pagination or auth mechanics, public API changes) need an issue first, so we can agree on the approach before you write code. Significant design decisions are recorded as an ADR in [`docs/adr/`](docs/adr) (copy `0000-template.md`).
- **New connectors** do not need an issue, but check the [catalog](docs/connectors.md) and open PRs first. A [connector request](https://github.com/itzzzzzzak/connector-kit/issues/new/choose) is the place to say you are working on one.
- By contributing you agree your work is released under the project's [MIT license](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need **Node.js 22 or newer** and [pnpm](https://pnpm.io) (the exact version is pinned in `package.json`; `corepack enable` picks it up).

```bash
git clone https://github.com/<you>/connector-kit && cd connector-kit   # your fork
pnpm install
pnpm typecheck     # builds, then type-checks the source and the examples
pnpm test          # compiles and runs the whole test suite
```

The Postgres token-store tests run only when `DATABASE_URL` is set (CI always runs them). To run them locally:

```bash
docker compose up -d
DATABASE_URL=postgres://connectorkit:connectorkit@localhost:5432/connectorkit pnpm test
```

### Repository map

| Path | What lives there |
|---|---|
| `src/` | The runtime: `define`, `execute`, `kit`, pagination, retries, OAuth, token stores, `tools`, `mcp` |
| `src/connectors/<name>/` | One folder per connector (`index.ts` plus tests; large ones have generated parts) |
| `src/bin/mcp.ts` | The `connector-kit-mcp` command |
| `scripts/` | Scaffolding, OpenAPI generation, catalog and export sync, smoke tests |
| `docs/` | Guides, the generated [connector catalog](docs/connectors.md), and [ADRs](docs/adr) |
| `examples/` | Runnable examples |

## The development loop

```bash
pnpm build         # compile to dist/ (also what the MCP command runs)
pnpm test          # run everything; add a failing test first when fixing a bug
pnpm typecheck     # strict type check, including examples
pnpm smoke         # pack the library and install it into an empty project
pnpm check:generated   # fails if package exports or docs/connectors.md are out of date
```

Run **`pnpm smoke`** if you touched `package.json`, the exports, or the build: unit tests passing does not prove a stranger can install and use the package. Run **`pnpm sync && pnpm catalog`** after adding or changing a connector; the catalog and the `exports` map are generated, never edited by hand.

## Contributing a connector

**Read [docs/writing-connectors.md](docs/writing-connectors.md) first.** It is the full guide: how to choose actions, how to write descriptions a model can act on, schemas, auth kinds, account-specific hosts, pagination, and the required tests. In short:

```bash
pnpm new:connector acme        # creates src/connectors/acme/ and its package export
# replace every TODO (the conformance check fails until you do)
pnpm typecheck && pnpm test && pnpm smoke
pnpm sync && pnpm catalog && pnpm check:generated
```

A good connector PR:

- [ ] Is built from the provider's **official** API documentation (linked in `meta.docsUrl`), with descriptions in **your own words**, not pasted docs.
- [ ] Gives every action an LLM-readable `description` (what it returns and when to use it), strict Zod `input` and `output`, and the right `effect`: `read`, `write` or `destructive`. A `GET` is `read`; a `DELETE` is `destructive`.
- [ ] Marks `safeToRetry: true` only on actions where repeating the call cannot change the outcome, and **never** on a `POST`.
- [ ] Uses a pagination strategy from core rather than hand-rolled paging, and declares optional `cursor` and `pageSize` inputs on paginated actions.
- [ ] Implements `detectError` if the API reports failures inside a `200`.
- [ ] Has tests with a fake `fetch` for **every action**: success, `404`, `429`, a malformed response, bad input (nothing is sent), and for writes, a `5xx` that is not retried.
- [ ] Is marked **`docs-based`** unless you ran it against the real service and can show the evidence. Never claim `live-tested` because it looks right.
- [ ] Keeps hand-written HTTP logic to a minimum; if you need it, say why in the PR.

The conformance check (`src/conformance.ts`) runs over every connector and enforces the shape rules. It checks shape, not truth: whether a path really exists at the provider is what your tests and a live check are for.

## Verifying a connector against a real account

This is the most valuable contribution you can make. To move a connector from `docs-based` to `live-tested`:

1. Use a test account, sandbox or read-only token. **Never share real customer data.**
2. Run each read action; for writes, run each once by hand in a throwaway workspace.
3. Open a PR that changes only `status` to `live-tested` and fixes any mismatch you found, with: the date, which actions you ran, and what you had to fix. Redact every token and personal detail in logs.

Found a mistake by reading rather than running? An issue or a PR with the fix is just as welcome.

## Pull requests

1. **Fork and branch from `main`** (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`).
2. **Keep it focused.** One concern per PR; a PR you cannot explain in two sentences is two PRs.
3. **Title it `type: summary`** following [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`; `feat!:` for breaking changes. Examples: `feat: add the Acme connector`, `fix: stop retrying Stripe POSTs without an idempotency key`. The squash-merge uses this title, and the release tooling reads it to decide the version bump and write the changelog, so it matters.
4. **Fill in the PR template** and make sure `pnpm typecheck`, `pnpm test` and `pnpm check:generated` pass locally. CI runs them on Node 22 and 24, plus a packaging check and a real-Postgres job.
5. **Respond to review.** Maintainers merge with *Squash and merge*. See [MAINTAINING.md](MAINTAINING.md) for how reviews and releases work.

Expect reviewers to ask: Could a model or an untrusted caller misuse this? Could a secret end up in an error, log or tool result? Are the failure paths tested? Does it keep the architecture rules below?

## Engineering rules

These are the invariants we protect. A change that breaks one needs an ADR and a strong reason.

- **The core knows nothing about agents; adapters know nothing about providers.** Every call goes through `execute`.
- **Never log or return secrets.** Credentials appear only in the outgoing auth header: not in errors, logs, tool output or `JSON.stringify(error)`.
- **Safety rules are tested, not trusted.** A change to validation, retries, secrets handling, path or host checks, or the policy hook needs a test that **fails when the rule is removed**.
- **Test failure paths,** not just the happy path: expired tokens, `429`s, `5xx` on writes, malformed responses.
- **Writes are never retried unless proven safe.** After a timeout you cannot know whether a `POST` happened.
- **Inputs from a model are untrusted.** Path parameters, hosts and cursors must not be able to leave the connector's base URL.
- **Be honest in the catalog.** `docs-based` and `live-tested` mean what they say.
- **Decisions are written down.** Significant design changes need an ADR.

## Using AI tools to contribute

AI assistants are welcome, and this project is built for them. You are still the author: you are responsible for understanding every line you submit, for running the tests, and for checking connector details against the provider's real documentation. Do not paste unreviewed model output, invented endpoints or copied documentation text. PRs that look auto-generated and unverified will be closed.

## Getting help

- **Questions or ideas:** open an issue using the template that fits.
- **Not sure it is in scope?** Check the non-goals in the [README](README.md#non-goals), then ask in an issue before building.
- **Stuck on a connector?** Read an existing one: [`src/connectors/github`](src/connectors/github/index.ts) is the reference, and [`src/connectors/slack`](src/connectors/slack/index.ts) shows errors reported inside a `200`.

Thank you for making connector-kit better.
