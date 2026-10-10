// Runs INSIDE the throwaway project that scripts/smoke-install.mjs installs the tarball into.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readdirSync } from "node:fs"
import { createConnectorKit, defineConnector, ConnectorKitError, memoryTokenStore, postgresTokenStore, encryptedStore, createEncryption, generateEncryptionKey } from "connector-kit"
import { github } from "connector-kit/github"
import { slack } from "connector-kit/slack"
import { createMcpHandler, serveMcp } from "connector-kit/mcp"

assert.equal(typeof createConnectorKit, "function")
assert.equal(typeof defineConnector, "function")
assert.equal(typeof ConnectorKitError, "function")
// OAuth building blocks must work from the installed package: store + encryption round trip.
const secureStore = encryptedStore(memoryTokenStore(), createEncryption({ current: "k1", keys: { k1: generateEncryptionKey() } }))
await secureStore.set("cred/smoke/u", "secret")
assert.equal(await secureStore.get("cred/smoke/u"), "secret")
assert.equal(typeof createConnectorKit({ tokenStore: memoryTokenStore() }).startAuth, "function")
assert.equal(typeof postgresTokenStore, "function")
assert.equal(typeof createMcpHandler, "function")
assert.equal(typeof serveMcp, "function")
assert.deepEqual(Object.keys(github.actions).sort(), ["issues.list", "repos.get"])
assert.deepEqual(Object.keys(slack.actions).sort(), ["chat.postMessage", "conversations.history", "conversations.list", "users.info"])

const kit = createConnectorKit({ fetch: async () => new Response("{}", { status: 200 }) })
const tools = kit.toTools(kit.connect(github, { connectionId: "smoke", credentials: { token: "x" } }))
assert.deepEqual(tools.map((t) => t.name).sort(), ["github_issues_list", "github_repos_get"])

const shipped = readdirSync("node_modules/connector-kit/dist", { recursive: true }).map(String)
assert.ok(!shipped.some((f) => /\.test\.|\.map$/.test(f)), "tests or source maps leaked into the package")

// The installed CLI must speak MCP over stdio exactly as a host (Claude Desktop, Cursor, ...) would use it.
// Run the command npm links from the package's `bin` field, the same one a user's config would call.
const child = spawn("node_modules/.bin/connector-kit-mcp", ["github"], {
  env: { PATH: process.env.PATH, GITHUB_TOKEN: "smoke_fake_token" },
  stdio: ["pipe", "pipe", "ignore"],
})
const replies = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("installed MCP CLI did not answer within 10s")), 10_000)
  const got = []
  let buffer = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf("\n")) >= 0) {
      got.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
    if (got.length === 2) {
      clearTimeout(timer)
      resolve(got)
    }
  })
  child.on("error", reject)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n")
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n")
})
child.kill()
assert.equal(replies[0].result.serverInfo.name, "connector-kit-github")
assert.deepEqual(replies[1].result.tools.map((t) => t.name).sort(), ["github_issues_list", "github_repos_get"])

console.log("smoke ok: installed from tarball, imports work, tools generate, MCP server answers over stdio, no test files shipped")
