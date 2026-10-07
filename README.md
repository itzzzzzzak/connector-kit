# connector-kit

[![CI](https://github.com/itzzzzzzak/connector-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/itzzzzzzak/connector-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![Status](https://img.shields.io/badge/status-pre--0.1-orange)

**Define a SaaS integration once. Call it from your app, or hand it to an AI agent as tools.**

connector-kit is an open-source TypeScript library for building and running connectors to external APIs. You describe *what* an API looks like (its actions, inputs, outputs, pagination), and the runtime handles *how* to call it safely: validation, authentication, rate limits, retries, pagination, and error normalization.

It is designed **agent-first**. Every action is a typed, validated, LLM-readable tool, and the same definition also gives you a normal developer SDK.

> **Status: pre-0.1.** The core works end to end against the real GitHub API (see [Quickstart](#quickstart)), but OAuth, token storage, an MCP adapter, and more connectors are still ahead. See the [roadmap](#roadmap). Expect breaking changes until 1.0. Distributed from GitHub Releases, not npm.

## Why

Every product that talks to third-party APIs re-implements the same plumbing, and every AI agent that calls tools needs it to be *safe*: a model can invent arguments, repeat a call in a loop, or be steered by text inside an API response. connector-kit puts that plumbing, and those guardrails, in one small, permissively licensed (MIT) library instead of in every integration.

It is a **library, not a platform**: no server to run, no dashboard, no hosted service. It does not try to compete on connector count with established integration platforms; it competes on being small, embeddable, and safe by default.

## Install

connector-kit is distributed from **GitHub Releases**, not npm. Each release has a prebuilt tarball (with a `SHA256SUMS` file) that works with npm, pnpm, yarn and bun, and needs no build step or install scripts:

```bash
npm install https://github.com/itzzzzzzak/connector-kit/releases/download/v<version>/connector-kit-<version>.tgz
```

Pick a `<version>` (e.g. `0.1.0`) from the [Releases page](https://github.com/itzzzzzzak/connector-kit/releases) (the first release is still to come). Until then, or to hack on it, clone and build:

```bash
git clone https://github.com/itzzzzzzak/connector-kit && cd connector-kit
pnpm install && pnpm build
```

Then import the core from `connector-kit` and each connector from its own subpath, e.g. `connector-kit/github`.

## Quickstart

```bash
pnpm build && GITHUB_TOKEN=<a GitHub token with read access> pnpm example:quickstart
```

The example ([examples/quickstart.ts](examples/quickstart.ts)) calls the real GitHub API:

```ts
import { createConnectorKit } from "connector-kit"
import { github } from "connector-kit/github"

const kit = createConnectorKit({
  // You decide policy; the kit just asks. Here, nothing destructive runs.
  beforeExecute: ({ effect }) =>
    effect === "destructive" ? { allow: false, reason: "destructive actions are disabled" } : { allow: true },
})

// One connection = one end user's account.
const gh = kit.connect(github, { connectionId: "user_42", credentials: { token } })

// As a developer SDK: typed in, typed out. One bounded page per call.
const repo = await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })
const page = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World" })
//    page = { items: [...], nextCursor: string | null }

// Or loop over everything (developer convenience; agents use one page at a time):
for await (const issue of kit.paginate(gh, "issues.list", { owner: "octocat", name: "Hello-World" })) {
  /* ... */
}

// As agent tools: pass these to an LLM API.
const tools = kit.toTools(gh) // [{ name: "github_issues_list", description, inputSchema, run }, ...]
const result = await tools[0].run({ owner: 123 }) // -> { ok: false, error: { code: "invalid_input", ... } }
```

## Writing a connector

A connector is a declarative description. Zod schemas give you compile-time types, runtime validation, and the JSON Schema that LLMs need, from one definition:

```ts
import { defineConnector, linkHeaderPagination } from "connector-kit"
import { z } from "zod"

export const github = defineConnector({
  name: "github",
  baseUrl: "https://api.github.com",
  auth: { type: "bearer" },
  actions: {
    "repos.get": {
      description: "Get details about a GitHub repository. Use when the user asks about a specific repo.",
      method: "GET",
      path: "/repos/{owner}/{name}",
      input: z.object({ owner: z.string(), name: z.string() }),
      output: repository,
      effect: "read", // "read" | "write" | "destructive": your policy hook decides what to allow
    },
    "issues.list": {
      description: "List issues in a repository. Returns one bounded page; pass nextCursor to get more.",
      method: "GET",
      path: "/repos/{owner}/{name}/issues",
      input: z.object({ owner: z.string(), name: z.string(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(issue),
      effect: "read",
      paginate: linkHeaderPagination(), // provider paging mechanics live in a reusable strategy
    },
  },
})
```

See [src/connectors/github](src/connectors/github/index.ts) for the full reference connector. To add one, create `src/connectors/<name>/` and a subpath export; see [CONTRIBUTING.md](CONTRIBUTING.md).

## What the runtime does for you

| Concern | Behavior |
|---|---|
| **Input** | Validated before any network call (models invent arguments). Path parameters cannot escape their segment (`..` is rejected), and every request, including pagination cursors, must stay under the connector's base URL. |
| **Errors** | A small fixed set (`auth_expired`, `forbidden`, `rate_limited`, `not_found`, `invalid_input`, `denied`, `upstream_error`), each with `retryable` and a message written for a model. Provider detail lives in a non-enumerable `error.raw`, so it stays out of logs. |
| **Rate limits** | `429` (and GitHub-style `403`) wait for `Retry-After` within a shared 30 s budget; longer waits return `rate_limited` with `retryAfter` instead of hanging your function or agent. |
| **Retries** | Exponential backoff with jitter. Failures where the outcome is unknown (timeout, `5xx`) are retried **only for reads or actions marked `safeToRetry`**, so a retry cannot create a duplicate. |
| **Pagination** | One bounded page per call (default 30, max 100) plus an opaque `nextCursor`. The same primitive serves agents and developers. |
| **Timeouts and size** | Every attempt has a deadline (30 s) and responses are size-capped (1 MB). |
| **Secrets** | Tokens appear only in the outgoing auth header: never in errors, tool results, or `JSON.stringify(error)`. |
| **Policy** | An optional `beforeExecute` hook sees each call's `effect` and validated input and can allow or deny (async, so a human can approve). It **fails closed**: if the hook throws, the action does not run. |

The reasoning behind each decision is in [docs/adr](docs/adr), and the design overview is in [docs/notebook.md](docs/notebook.md).

## Roadmap

- [x] Core runtime: `defineConnector`, validated `execute`, normalized errors
- [x] Pagination (`{ items, nextCursor }`, `kit.paginate`)
- [x] Retries and bounded rate-limit waiting
- [x] `toTools()` and the `beforeExecute` policy hook
- [x] GitHub reference connector, verified against the real API
- [ ] `TokenStore` (in-memory + Postgres, encrypted at rest) and OAuth 2.0 (`startAuth` / `finishAuth`, `state`, PKCE, token refresh with locking)
- [ ] MCP server adapter
- [ ] More connectors and pagination strategies (body cursor, offset)
- [ ] Webhook verification and delivery de-duplication
- [ ] First GitHub Release (`0.1.0`)

Have an idea or a connector you need? [Open an issue](https://github.com/itzzzzzzak/connector-kit/issues/new/choose).

## What's in the box

| Path | Purpose |
|---|---|
| [`connector-kit`](src) | The runtime (`defineConnector`, `createConnectorKit`, retries, pagination, `toTools()`, policy hook) |
| [`connector-kit/github`](src/connectors/github) | GitHub connector (reference implementation) |
| [`examples/`](examples) | Runnable examples |
| [`docs/`](docs) | Design notebook and [architecture decision records](docs/adr) |

## Non-goals

A hosted service, a UI, a data-sync engine, a workflow engine, an agent loop, or a built-in policy engine. Those belong in other layers that can be built *on top of* this library.

## Contributing

Contributions are welcome, especially connectors. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security issues: [SECURITY.md](SECURITY.md). Maintainers: [MAINTAINING.md](MAINTAINING.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
