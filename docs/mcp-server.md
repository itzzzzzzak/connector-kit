# MCP server

`connector-kit-mcp` serves a connector's actions as tools to any [MCP](https://modelcontextprotocol.io) client (Claude, Cursor and others), with no code. This page is the full reference. For the five-minute version, see the [README](../README.md#quickstart).

## Install

You need **Node.js 22 or newer**.

### From a release (recommended)

Each [GitHub Release](https://github.com/itzzzzzzak/connector-kit/releases) has a prebuilt tarball (with a `SHA256SUMS` file). It works with npm, pnpm, yarn and bun, and needs no build step or install scripts:

```bash
npm install https://github.com/itzzzzzzak/connector-kit/releases/download/v<version>/connector-kit-<version>.tgz
```

Replace `<version>` with the version on the [Releases page](https://github.com/itzzzzzzak/connector-kit/releases) (for example `0.5.0`). This gives you:

- the library: `import { createConnectorKit } from "connector-kit"`, and one import path per connector, such as `connector-kit/github`;
- the MCP server command: `npx connector-kit-mcp` (the file is `node_modules/.bin/connector-kit-mcp`).

### From source

```bash
git clone https://github.com/itzzzzzzak/connector-kit && cd connector-kit
pnpm install && pnpm build
```

The MCP server is then `node /abs/path/to/connector-kit/dist/bin/mcp.js`. Use an absolute path in client configs.

Check that it works by listing the connectors:

```bash
npx connector-kit-mcp --list          # release install
node dist/bin/mcp.js --list           # source checkout
```

Each line shows the connector name, the environment variable it reads its credential from, its status, and any `--var` it needs:

```text
github           GITHUB_TOKEN             live-tested
jira             JIRA_CREDENTIALS         docs-based   --var site=...
slack            SLACK_BOT_TOKEN          docs-based
stripe           STRIPE_API_KEY           docs-based
zendesk          ZENDESK_CREDENTIALS      docs-based   --var subdomain=...
...
```

## Running the server

`connector-kit-mcp` serves **one connector per process** over stdio ([MCP](https://modelcontextprotocol.io)). Add one server entry per connector you want.

```text
connector-kit-mcp <connector> [--var name=value ...] [--only a,b] [--group g1,g2] [--allow-writes]
connector-kit-mcp --list
```

| Option | What it does |
|---|---|
| `<connector>` | The connector name from `--list`, e.g. `github`, `google-calendar`. |
| `--group g1,g2` | Expose only these groups of actions. A group is the part of an action name before the dot (`issues` in `issues.list`). |
| `--only a,b` | Expose only these actions, e.g. `repos.get,issues.list`. |
| `--var name=value` | A value for an account-specific address, e.g. `--var subdomain=acme`. Repeat for several. `--list` shows which connectors need one. |
| `--allow-writes` | Allow actions that change data. **Without it the server is read-only.** |
| `--list` | Print every connector, its credential variable, status and required `--var`. |
| `--help` | Print usage. |

Rules the server enforces:

- **The credential comes from an environment variable** (shown by `--list`), never from a command-line argument. If it is missing, the server exits with `Set GITHUB_TOKEN in the environment`.
- **Read-only by default.** `write` actions are refused unless you pass `--allow-writes`. `destructive` actions (delete, refund, ban...) are **never** allowed through this command; to allow them, embed the server in your own program with your own policy (see [below](#embed-the-mcp-server-in-your-own-program)).
- **Big connectors need a subset.** A connector with more than 40 actions will not start without `--group` or `--only`, because a model chooses worse from hundreds of tools. The error message lists every group with its size, so run it once without options to see them:

  ```text
  connector-kit-mcp: github has 1192 actions: too many to give a model at once. Choose with --group (actions (200), activity (34), ..., issues (61), ..., pulls (30), repos (202), ...) or --only action1,action2.
  ```

  The [catalog](connectors.md) also lists every connector's groups or actions.

### Claude Code

```bash
# Use an absolute path. Prefer a fine-grained, read-only token.
claude mcp add github -e GITHUB_TOKEN=<token> -- node /abs/path/to/connector-kit/dist/bin/mcp.js github --group issues,pulls
claude mcp add slack -e SLACK_BOT_TOKEN=<xoxb-token> -- node /abs/path/to/connector-kit/dist/bin/mcp.js slack --group chat,conversations,users
claude mcp add stripe -e STRIPE_API_KEY=<rk_test_...> -- node /abs/path/to/connector-kit/dist/bin/mcp.js stripe --group customers,invoices,balance
claude mcp add zendesk -e ZENDESK_CREDENTIALS='you@co.com/token:<api-token>' -- node /abs/path/to/connector-kit/dist/bin/mcp.js zendesk --var subdomain=acme --group tickets
```

With a release install, replace `node /abs/path/to/connector-kit/dist/bin/mcp.js` with the absolute path to `node_modules/.bin/connector-kit-mcp`.

### Claude Desktop, Cursor and other clients

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and most other clients use the same shape. Options go in `args`, the credential in `env`:

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/abs/path/to/connector-kit/dist/bin/mcp.js", "github", "--group", "issues,pulls"],
      "env": { "GITHUB_TOKEN": "<token>" }
    },
    "jira": {
      "command": "node",
      "args": ["/abs/path/to/connector-kit/dist/bin/mcp.js", "jira", "--var", "site=acme", "--group", "issueSearch,issues"],
      "env": { "JIRA_CREDENTIALS": "you@company.com:<api-token>" }
    }
  }
}
```

Restart the client after editing its config. The server logs one line to stderr when it starts, for example `connector-kit-mcp: serving github (3 tools, read-only)`; everything on stdout is protocol.

### What the client sees

- **Tool names** are `<connector>_<action>` with dots turned into underscores: `repos.get` on GitHub is `github_repos_get`.
- **Annotations** come from each action's `effect`: `readOnlyHint` is true for reads and `destructiveHint` for destructive actions, so clients can decide what to auto-approve.
- **Results** are JSON text. A failure is a normal tool result with `isError: true` and a body like `{"code": "invalid_input", "message": "...", "retryable": false}`, so the model can read it and correct itself (see [errors]ai-assistants.md#errors-and-what-to-do).
- **Large results are truncated** at 100,000 characters with a note asking for a smaller `pageSize` or narrower input.

### Embed the MCP server in your own program

To choose your own policy (for example, allow destructive actions after a human approves), build the tools yourself and serve them with `connector-kit/mcp`:

```ts
import { createConnectorKit } from "connector-kit"
import { github } from "connector-kit/github"
import { serveMcp } from "connector-kit/mcp"

const kit = createConnectorKit({
  // Your policy: here, ask a human before anything destructive (askHuman is your own function).
  beforeExecute: async ({ effect, action, input }) =>
    effect !== "destructive" || (await askHuman(action, input)) ? { allow: true } : { allow: false, reason: "a person declined it" },
})
const gh = kit.connect(github, { connectionId: "me", credentials: { token: process.env.GITHUB_TOKEN! } })
await serveMcp(kit.toTools(gh, { groups: ["issues", "repos"] }), { name: "my-github" })
```

The server has no dependencies and is tested against the official MCP SDK client ([ADR-013](adr/0013-mcp-server.md)).

## Credentials and account settings

Every connector reads **one credential string**. Its format depends on how the provider authenticates; the catalog's **Auth** column says which kind each connector uses.

| Auth kind | Credential format | Examples |
|---|---|---|
| Token, API key, OAuth access token | The token as is | `GITHUB_TOKEN=ghp_...`, `SLACK_BOT_TOKEN=xoxb-...`, `STRIPE_API_KEY=rk_test_...`, `NOTION_TOKEN=...` |
| HTTP Basic | `username:password`, in the provider's own form | Jira: `you@company.com:<api-token>`<br>Zendesk: `you@company.com/token:<api-token>`<br>Mailchimp: `anystring:<api-key>`<br>Twilio (all three): `<AccountSid>:<AuthToken>` or `<ApiKeySid>:<ApiKeySecret>` |
| Several API keys | The keys joined by `:` | Datadog: `DATADOG_KEYS=<api-key>:<application-key>` |

For connectors marked **OAuth 2.0 or token**, the MCP command takes an access token you already have. To let many end users connect their own accounts, use the library's [OAuth flow](library.md#connecting-your-users-accounts-oauth), which also refreshes tokens.

**Account-specific addresses.** Some APIs live at an address that depends on your account. These connectors need a value supplied by you, never by the model, because it decides which server receives your credential. Run `--list` for the current set; today they include:

| Connector | Variable | Example |
|---|---|---|
| `zendesk` | `subdomain`: the part before `.zendesk.com` | `--var subdomain=acme` |
| `jira` | `site`: the part before `.atlassian.net` | `--var site=acme` |
| `mailchimp` | `dc`: the part of the API key after the dash | `--var dc=us19` |
| `sentry` | `region`: `us` or `de` | `--var region=us` |
| `datadog` | `site`: the domain you sign in at, without `app.` | `--var site=datadoghq.com` |
| `shopify` | `shop`: the part before `.myshopify.com` | `--var shop=acme-store` |
| `salesforce` | `domain`: the part before `.my.salesforce.com` | `--var domain=acme` |

In the library, pass the same values as `variables`: `kit.connect(zendesk, { connectionId, credentials: { token }, variables: { subdomain: "acme" } })`. A missing or invalid value fails at `connect()` with a message that names it.
