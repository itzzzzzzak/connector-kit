# Using connector-kit as a library

Import the runtime and any connector into your Node app. Every action is a typed SDK call, and the same definition becomes LLM tools. See [install](mcp-server.md#install) first.

## SDK calls

```bash
pnpm build && GITHUB_TOKEN=<a GitHub token with read access> pnpm example:quickstart
```

That runs [examples/quickstart.ts](../examples/quickstart.ts) against the real GitHub API. The core of it:

```ts
import { createConnectorKit } from "connector-kit"
import { github } from "connector-kit/github"

const kit = createConnectorKit({
  // You decide policy; the kit just asks. Without a hook, every action is allowed.
  beforeExecute: ({ effect }) =>
    effect === "destructive" ? { allow: false, reason: "destructive actions are disabled" } : { allow: true },
})

// One connection = one account.
const gh = kit.connect(github, { connectionId: "user_42", credentials: { token: process.env.GITHUB_TOKEN! } })

// As a developer SDK: typed in, typed out.
const repo = await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })

// List actions return one bounded page and a cursor.
const page = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", pageSize: 10 })
// page = { items: [...], nextCursor: string | null }
const next = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", cursor: page.nextCursor! })

// Or loop over every page (a developer convenience; agents take one page at a time):
for await (const issue of kit.paginate(gh, "issues.list", { owner: "octocat", name: "Hello-World" })) {
  console.log(issue.title)
}
```

Failures throw a `ConnectorKitError` with a `code` from a small fixed set (see [errors](ai-assistants.md#errors-and-what-to-do)), a `retryable` flag, and `retryAfter` when the provider gave one.

### Hand a connector to an LLM as tools

`kit.toTools(connection, options)` returns tools in the shape LLM tool-calling APIs expect: `{ name, description, inputSchema, effect, run }`. `run(input)` validates the input, applies your policy, calls the API, and **never throws for an API failure**: it returns `{ ok: true, data }` or `{ ok: false, error: { code, message, retryable, retryAfter? } }` for the model to read.

```ts
const tools = kit.toTools(gh, { only: ["repos.get", "issues.list"] })   // or { groups: ["issues", "pulls"] }
const result = await tools[1].run({ owner: 123 })                       // tools[1] is github_issues_list
// -> { ok: false, error: { code: "invalid_input", message: "Invalid input for \"issues.list\": owner: ...", retryable: false } }
```

With the Anthropic SDK (`@anthropic-ai/sdk`), a minimal tool loop looks like this. Any other provider's tool format maps the same three fields.

```ts
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic()
const byName = new Map(tools.map((t) => [t.name, t]))
const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What are the open issues in octocat/Hello-World?" }]

while (true) {
  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4096,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
    messages,
  })
  messages.push({ role: "assistant", content: response.content })
  if (response.stop_reason !== "tool_use") break

  const results: Anthropic.ToolResultBlockParam[] = []
  for (const block of response.content) {
    if (block.type !== "tool_use") continue
    const result = await byName.get(block.name)!.run(block.input)
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: JSON.stringify(result.ok ? result.data : result.error),
      is_error: !result.ok,
    })
  }
  messages.push({ role: "user", content: results })
}
```

## Connecting your users' accounts (OAuth)

For a product with many users, each user connects their own account. connector-kit runs **no server**: you host two routes, and the kit does the security-sensitive parts (state, PKCE, token storage, refresh).

```ts
import { createConnectorKit, createEncryption, encryptedStore, memoryTokenStore } from "connector-kit"
import { github } from "connector-kit/github"

const kit = createConnectorKit({
  // memoryTokenStore() is for trying it out. In production use a durable store and keep the key in a secret manager.
  tokenStore: encryptedStore(memoryTokenStore(), createEncryption({ current: "k1", keys: { k1: process.env.ENCRYPTION_KEY! } })),
  oauth: { github: { clientId: "...", clientSecret: "...", redirectUri: "https://yourapp.com/callback" } },
})

// Route 1: user clicks "Connect GitHub"
const { url } = await kit.startAuth(github, { connectionId: user.id }) // add scopes: ["repo"] for private repos
redirect(url)

// Route 2: GitHub sends the user back to https://yourapp.com/callback?code=...&state=...
await kit.finishAuth(github, { code, state, expectedConnectionId: user.id })

// Anywhere later: no token handling. Expired tokens are refreshed for you.
const gh = kit.connect(github, { connectionId: user.id })
await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })

// When the user disconnects:
await kit.disconnect(github, { connectionId: user.id })
```

Generate an encryption key with `generateEncryptionKey()`. A runnable version is [examples/oauth-server.ts](../examples/oauth-server.ts). What the kit does for you, and why ([ADR-014](adr/0014-oauth-and-token-store.md)):

| Risk | How it is handled |
|---|---|
| Forged login (CSRF) | A random `state`, stored server-side, **single use**, expires in 10 minutes, bound to the `connectionId`. `expectedConnectionId` rejects a login started for someone else. PKCE (S256) is on by default. |
| Tokens stolen from the database | `encryptedStore`: AES-256-GCM, a fresh nonce per value, and the record's key bound in as authenticated data, so records cannot be swapped between users. Key rotation is supported. |
| Expired tokens | Refreshed silently shortly before expiry. A rotating refresh token is saved. |
| The refresh race | Concurrent calls refresh **once** (a lock plus re-reading the record inside it); important because many providers invalidate a refresh token the moment it is used. |
| Token expires mid-call | A `401` triggers one refresh and one retry (safe for any action: the provider rejected the request). |
| A dead connection | A revoked refresh token deletes the record; callers get `auth_expired`, then `not_connected`. A transient provider error never logs a user out. |
| Secrets in errors | Provider free text lives only in the non-enumerable `error.raw`. Token and authorize URLs must be https. |

### Token stores

`TokenStore` is a small interface (`get/set/delete`, `putTemp/takeTemp`, `withLock`). **A store shared by several servers must implement `withLock` across processes**, or the refresh race comes back. Two are included:

- `memoryTokenStore()`: for trying it out and tests. Nothing survives a restart, and its lock covers one process only.
- `postgresTokenStore(pool)`: durable, and its lock works **across servers**. Pass any `pg` pool (or anything with `query(text, values)`); call `await store.migrate()` once (or run `store.schemaSql()` in your own migrations). Wrap it: `encryptedStore(postgresTokenStore(pool), encryption)` so the table only ever holds ciphertext. Expiry uses the database's clock, `takeTemp` is one atomic `DELETE ... RETURNING`, and the lock is a lease row (no connection is held while waiting; a crashed server's lease expires), tested against a real Postgres in CI.

Writing your own store (Redis, DynamoDB, ...)? The shared contract in [src/store-contract.test.ts](../src/store-contract.test.ts) is the spec your store must pass.
