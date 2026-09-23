# connector-kit

> Define an integration once. Use it from your app, or hand it to an AI agent as tools.

**Status: early development (pre-0.1). Not usable yet.**

ConnectorKit is an open-source TypeScript library for building and running production-quality connectors to external SaaS APIs. It handles the parts every integration re-implements: authentication, token refresh, pagination, rate limits, retries and error normalization. A connector author describes *what* the API looks like, and the runtime handles *how* to call it safely.

It is designed **agent-first**: every action is a typed, validated, LLM-readable tool, and the same definition also produces a normal developer SDK.

## Why

Existing options tend to be source-available rather than open source, closed at the runtime layer, or built for batch ETL rather than agent tool calls. ConnectorKit aims to be a small, permissively licensed (MIT) core that is easy to write connectors for and easy to plug into AI products.

## Design in one picture

```text
   Agent app / developer app
             |
   ADAPTERS:  toTools()  ·  MCP  ·  typed SDK  ·  webhooks (later)
             |
   CORE: execute(action, input, connectionId)
         hook → validate → auth/refresh → rate limit → retry → paginate → normalize
        /                                  \
   CONNECTORS (definitions)            STORES (TokenStore: memory, Postgres)
```

See [docs/notebook.md](docs/notebook.md) for the full design and [docs/adr](docs/adr) for decisions.

## Target API (subject to change)

```ts
const kit = createConnectorKit({ tokenStore: postgresStore(db) })
const gh = kit.connect(github, { connectionId: "user_42" })

const repo = await gh.repos.get({ owner: "acme", name: "api" })
const tools = kit.toTools(gh) // hand to an LLM
```

## Non-goals

No hosted service, no UI, no sync engine, no agent loop, no workflow engine, no built-in policy engine. See the notebook.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/core` | Runtime: `defineConnector`, `execute`, auth, HTTP, stores |
| `packages/connector-github` | First connector (reference implementation) |
| `docs/` | Design notebook and architecture decision records |
| `examples/` | Runnable examples |

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
