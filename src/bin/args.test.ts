import assert from "node:assert/strict"
import { test } from "node:test"
import { mcpPolicy, parseMcpArgs } from "./args.js"

const ctx = (effect: "read" | "write" | "destructive") => ({ connector: "c", action: "a", effect, input: {}, connectionId: "mcp" })

test("a connector name alone means read-only with every action", () => {
  assert.deepEqual(parseMcpArgs(["github"]), { connector: "github", allowWrites: false, list: false })
})
test("--only and --allow-writes are parsed in any position", () => {
  assert.deepEqual(parseMcpArgs(["--allow-writes", "github", "--only", "repos.get, issues.list"]), { connector: "github", allowWrites: true, list: false, only: ["repos.get", "issues.list"] })
})
test("bad usage returns an error message instead of throwing", () => {
  for (const argv of [[], ["--nope", "github"], ["github", "extra"], ["github", "--only"]]) {
    assert.ok("error" in parseMcpArgs(argv), JSON.stringify(argv))
  }
})

test("policy: read-only by default, writes only when opted in, destructive never", async () => {
  const readOnly = mcpPolicy(false)
  assert.deepEqual(await readOnly(ctx("read")), { allow: true })
  assert.equal((await readOnly(ctx("write"))).allow, false)
  assert.equal((await readOnly(ctx("destructive"))).allow, false)

  const writes = mcpPolicy(true)
  assert.deepEqual(await writes(ctx("read")), { allow: true })
  assert.deepEqual(await writes(ctx("write")), { allow: true })
  assert.equal((await writes(ctx("destructive"))).allow, false)
})

test("--list needs no connector name", () => {
  assert.deepEqual(parseMcpArgs(["--list"]), { allowWrites: false, list: true })
})

test("--var collects name=value pairs, keeps '=' inside values, and works with other flags", () => {
  assert.deepEqual(parseMcpArgs(["zendesk", "--var", "subdomain=acme", "--var", "token=a=b=c", "--allow-writes"]), { connector: "zendesk", allowWrites: true, list: false, variables: { subdomain: "acme", token: "a=b=c" } })
})

test("--var without a name or an '=' is an error, not a silent skip", () => {
  for (const argv of [["zendesk", "--var"], ["zendesk", "--var", "acme"], ["zendesk", "--var", "=x"]]) assert.ok("error" in parseMcpArgs(argv), JSON.stringify(argv))
})

test("--group takes a comma-separated list and needs a value", () => {
  assert.deepEqual((parseMcpArgs(["github", "--group", "issues, repos"]) as { groups?: string[] }).groups, ["issues", "repos"])
  assert.match((parseMcpArgs(["github", "--group"]) as { error: string }).error, /--group needs/)
})
