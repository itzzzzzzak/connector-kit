// Opt-in smoke test against the REAL GitHub API. Skipped unless GITHUB_TOKEN is set, so CI
// and contributors without a token are unaffected. Run it with:
//   GITHUB_TOKEN=... pnpm --filter @connector-kit/github test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "@connector-kit/core"
import { github } from "./index.js"

const token = process.env.GITHUB_TOKEN
const skip = token ? false : "set GITHUB_TOKEN to run live tests"

function live() {
  const kit = createConnectorKit()
  return { kit, gh: kit.connect(github, { connectionId: "live", credentials: { token: token! } }) }
}

test("live: repos.get matches our schema on a real repository", { skip }, async () => {
  const { gh } = live()
  const repo = await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })
  assert.equal(repo.full_name, "octocat/Hello-World")
})

test("live: issues.list returns a bounded page and a usable cursor", { skip }, async () => {
  const { gh } = live()
  const page = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", pageSize: 3 })
  assert.ok(page.items.length <= 3)
  if (page.nextCursor !== null) {
    const next = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", pageSize: 3, cursor: page.nextCursor })
    assert.ok(next.items.length <= 3)
    assert.notDeepEqual(next.items[0], page.items[0])
  }
})

test("live: a repo that does not exist is not_found", { skip }, async () => {
  const { gh } = live()
  await assert.rejects(
    () => gh.execute("repos.get", { owner: "octocat", name: "this-repo-does-not-exist-connector-kit" }),
    (e: unknown) => (e as { code?: string }).code === "not_found",
  )
})
