<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" alt="connector-kit: define a SaaS integration once, call it from your app or hand it to an agent as tools" width="100%">
</picture>

# Connect your product and AI agents to SaaS APIs, safely.

Open-source TypeScript connectors with built-in auth, retries, pagination and guardrails. Use them as an MCP server in Claude or Cursor, as a typed SDK in your app, or as tools for any LLM.

[Connector catalog](docs/connectors.md) · [MCP server](docs/mcp-server.md) · [Library](docs/library.md) · [For AI assistants](docs/ai-assistants.md) · [Releases](https://github.com/itzzzzzzak/connector-kit/releases)

[![CI](https://github.com/itzzzzzzak/connector-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/itzzzzzzak/connector-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/itzzzzzzak/connector-kit)](https://github.com/itzzzzzzak/connector-kit/releases)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![Status](https://img.shields.io/badge/status-pre--1.0-orange)

</div>

## What is connector-kit?

connector-kit is an open-source (MIT) library of connectors to SaaS APIs: GitHub, Slack, Stripe, Notion, Linear, Google Workspace, Microsoft 365, Jira, HubSpot and many more. See the [catalog](docs/connectors.md) for the full, always-current list.

Each connector describes *what* an API looks like (actions, inputs, outputs, paging). The runtime handles *how* to call it safely: validation, authentication, rate limits, retries, pagination and error normalization. The same definition works three ways:

| You want to... | Use | Needs code? |
|---|---|---|
| Give Claude, Cursor or another MCP client access to an API | [`connector-kit-mcp`](docs/mcp-server.md) | No |
| Call an API from your own app with types and guardrails | [the SDK](docs/library.md#sdk-calls) | Yes |
| Give your own LLM agent safe tools | [`kit.toTools()`](docs/library.md#hand-a-connector-to-an-llm-as-tools) | Yes |

It is a **library, not a platform**: no server to run, no dashboard, no hosted service. You import only the connector you use, and nothing runs until you call it.

> **Status: pre-1.0.** The core (validation, OAuth, token storage, retries, pagination, MCP server) is tested end to end. Only GitHub has been run against its real API so far; every other connector is built from the provider's official API description and tested against fake servers, and the catalog marks each one honestly. Expect breaking changes until 1.0. Distributed from GitHub Releases, not npm.

## Quickstart

You need **Node.js 22+**. This gives Claude Code read-only access to GitHub in about two minutes.

**1. Install.** Download the tarball from the [latest release](https://github.com/itzzzzzzak/connector-kit/releases) (it works with npm, pnpm, yarn and bun), or build from source:

```bash
git clone https://github.com/itzzzzzzak/connector-kit && cd connector-kit
pnpm install && pnpm build
node dist/bin/mcp.js --list        # every connector, the credential variable it reads, and its status
```

**2. Add a connector to your client.** One server per connector. Use an absolute path and a read-only token:

```bash
claude mcp add github -e GITHUB_TOKEN=<token> -- node /abs/path/to/connector-kit/dist/bin/mcp.js github --group issues,pulls
```

Claude Desktop and Cursor use the same command and `env` in their JSON config; see the [MCP server guide](docs/mcp-server.md#claude-desktop-cursor-and-other-clients).

**3. Ask.** "What are the open issues in octocat/Hello-World?" The server is **read-only by default**: writes need `--allow-writes`, and destructive actions are never allowed through this command.

Prefer code? The same connector as an SDK:

```ts
import { createConnectorKit } from "connector-kit"
import { github } from "connector-kit/github"

const kit = createConnectorKit({
  // You decide policy; the kit just asks.
  beforeExecute: ({ effect }) => (effect === "destructive" ? { allow: false, reason: "destructive actions are disabled" } : { allow: true }),
})
const gh = kit.connect(github, { connectionId: "me", credentials: { token: process.env.GITHUB_TOKEN! } })

const page = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", pageSize: 10 })
// page = { items: [...], nextCursor: string | null }

const tools = kit.toTools(gh, { groups: ["issues"] }) // hand these to any LLM tool-calling API
```

More: [credentials for each kind of connector](docs/mcp-server.md#credentials-and-account-settings), [OAuth for your users' accounts](docs/library.md#connecting-your-users-accounts-oauth), and a runnable [quickstart example](examples/quickstart.ts) (`pnpm example:quickstart`).

## Why connector-kit?

**Safe for agents by default.** A model can invent arguments, repeat a call in a loop, or be steered by text inside an API response. These rules are tested, not promised:

- **Every action says what it does.** Each is `read`, `write` or `destructive`, and your `beforeExecute` policy decides what may run.
- **Retries never duplicate a write.** Reads retry after a timeout or 5xx. A write is retried only when it is safe to (for example with idempotency keys), otherwise it fails once and says so.
- **Secrets stay out.** Credentials never appear in errors, logs or tool output.
- **A model cannot reach another server.** Hosts and paths are validated, so an invented argument cannot send your token elsewhere.
- **Bounded output.** Lists return one page at a time with a cursor, and large responses are capped, so an agent cannot flood its own context.

**Whole APIs, curated for models.** Big connectors cover the provider's whole API (GitHub alone has over a thousand actions), mostly generated from official API descriptions, with the most-used actions hand-written and typed. Actions are named `group.verb`, and you expose just the groups you need so the model sees a small, relevant tool set.

**Honest about quality.** Every connector is marked `live-tested` (run against the real API) or `docs-based` (written from official docs and tested against a fake server). We do not blur the two.

**Embeddable.** OAuth with PKCE, token refresh with locking, and encrypted token storage (memory and Postgres) are included for products that connect many users' accounts. You host two routes; the kit handles the security-sensitive parts.

**Small and permissive.** One dependency (`zod`), MIT license, no hosted service.

## For AI assistants

If you are an AI assistant setting this up for someone, or calling its tools, read **[docs/ai-assistants.md](docs/ai-assistants.md)**. It covers how to find the right connector and credential, which tools to expose, how paging works, when to confirm before a write, and what to do for each error code.

## Documentation

| Guide | What it covers |
|---|---|
| [MCP server](docs/mcp-server.md) | Install, every flag, client configs (Claude Code, Claude Desktop, Cursor), credentials and account settings |
| [Library](docs/library.md) | SDK calls, paging, LLM tools with a worked tool loop, OAuth, token stores |
| [For AI assistants](docs/ai-assistants.md) | Setup steps, calling rules, error codes |
| [Connector catalog](docs/connectors.md) | Every connector: import path, status, auth, required settings, actions or groups (generated, never stale) |
| [Writing a connector](docs/writing-connectors.md) | The full guide to adding one |
| [Architecture decisions](docs/adr) | Why it is built the way it is; [design notebook](docs/notebook.md) |

## Contributing

Contributions are welcome, and the most useful ones are **new connectors** and **reports from running a `docs-based` connector against a real account**. Start with [CONTRIBUTING.md](CONTRIBUTING.md); to add a connector:

```bash
pnpm install
pnpm new:connector acme        # scaffolds src/connectors/acme/ and its package export
# fill in every TODO, following docs/writing-connectors.md
pnpm typecheck && pnpm test && pnpm smoke
pnpm sync && pnpm catalog && pnpm check:generated
```

Found a bug or want a connector? [Open an issue](https://github.com/itzzzzzzak/connector-kit/issues/new/choose). Security problems: please follow [SECURITY.md](SECURITY.md) and do not open a public issue. Maintainers: [MAINTAINING.md](MAINTAINING.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Roadmap

- [x] Core runtime, validated `execute`, normalized errors, retries, bounded rate-limit waiting
- [x] Pagination for Link headers, body cursors, next-links, offsets, page numbers, last-item ids and GraphQL Relay
- [x] `toTools()` and the `beforeExecute` policy hook
- [x] OAuth 2.0 with PKCE, refresh with locking, encrypted token storage (memory and Postgres)
- [x] MCP server with `--group` filtering
- [x] Full API coverage generated from official API descriptions, Google Workspace and Microsoft 365
- [ ] Full coverage for Airtable and Calendly (no official machine-readable description; hand-written)
- [ ] Promote connectors to `live-tested` as they are run against real accounts
- [ ] Webhook verification and delivery de-duplication

## Non-goals

A hosted service, a UI, a data-sync engine, a workflow engine, an agent loop, or a built-in policy engine. Those belong in other layers built *on top of* this library.

## License

[MIT](LICENSE)
