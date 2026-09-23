import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "@connector-kit/core"
import { github } from "./index.js"

test("repos.get calls the GitHub REST endpoint and returns a typed repo", async () => {
  let seen: { url: string; headers: Headers } | undefined
  const kit = createConnectorKit({
    fetch: (async (input: URL | string, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers) }
      return new Response(
        JSON.stringify({
          id: 1,
          name: "api",
          full_name: "acme/api",
          private: false,
          html_url: "https://github.com/acme/api",
          description: null,
          default_branch: "main",
          stargazers_count: 5,
          some_extra_field: "ignored",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch,
  })

  const gh = kit.connect(github, { connectionId: "user_1", credentials: { token: "ghp_test" } })
  const repo = await gh.execute("repos.get", { owner: "acme", name: "api" })

  assert.equal(repo.full_name, "acme/api")
  assert.equal(repo.description, null)
  assert.equal(seen?.url, "https://api.github.com/repos/acme/api")
  assert.equal(seen?.headers.get("authorization"), "Bearer ghp_test")
  assert.equal(seen?.headers.get("user-agent"), "connector-kit")
})
