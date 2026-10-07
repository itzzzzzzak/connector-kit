// End-to-end conformance: the REAL MCP client from the official SDK drives our compiled CLI over stdio.
// If this passes, MCP hosts (Claude Desktop, Claude Code, Cursor, ...) can use the server.
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const cli = fileURLToPath(new URL("./mcp.js", import.meta.url))

async function connect(args: string[], env: Record<string, string> = { GITHUB_TOKEN: "ghp_fake_token_for_tests" }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], env: { PATH: process.env.PATH ?? "", ...env } })
  const client = new Client({ name: "conformance-test", version: "1.0.0" })
  await client.connect(transport)
  return client
}

test("a real MCP client can initialize, list tools, and call one", async () => {
  const client = await connect(["github"])
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["github_issues_list", "github_repos_get"])
    assert.equal(tools[0]!.inputSchema.type, "object")
    assert.equal(tools.every((t) => t.annotations?.readOnlyHint === true), true)

    // Bad arguments are rejected before any network call, so this needs no real token or network.
    const result = await client.callTool({ name: "github_repos_get", arguments: { owner: 123 } })
    assert.equal(result.isError, true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    assert.equal(JSON.parse(text).code, "invalid_input")
    assert.ok(!text.includes("ghp_fake_token_for_tests"))
  } finally {
    await client.close()
  }
})

test("--only limits which tools the client sees", async () => {
  const client = await connect(["github", "--only", "repos.get"])
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["github_repos_get"])
  } finally {
    await client.close()
  }
})

test("an unknown tool is an error the client surfaces", async () => {
  const client = await connect(["github"])
  try {
    await assert.rejects(() => client.callTool({ name: "github_delete_everything", arguments: {} }))
  } finally {
    await client.close()
  }
})

test("without a token the server refuses to start and says why", async () => {
  await assert.rejects(() => connect(["github"], {}))
})
