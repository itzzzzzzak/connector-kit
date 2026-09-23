import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectorKitError, createConnectorKit } from "@connector-kit/core"
import { github } from "./index.js"

const repoPayload = {
  id: 1,
  name: "api",
  full_name: "acme/api",
  private: false,
  html_url: "https://github.com/acme/api",
  description: null,
  default_branch: "main",
  stargazers_count: 5,
  some_extra_field: "ignored",
}

function githubWith(handler: (url: string, headers: Headers) => Response) {
  const calls: string[] = []
  const kit = createConnectorKit({
    fetch: (async (input: URL | string, init?: RequestInit) => {
      calls.push(String(input))
      return handler(String(input), new Headers(init?.headers))
    }) as typeof fetch,
  })
  return { gh: kit.connect(github, { connectionId: "user_1", credentials: { token: "ghp_test" } }), calls }
}

test("repos.get calls the GitHub REST endpoint and returns a typed repo", async () => {
  let seen: { url: string; headers: Headers } | undefined
  const { gh } = githubWith((url, headers) => {
    seen = { url, headers }
    return new Response(JSON.stringify(repoPayload), { status: 200, headers: { "content-type": "application/json" } })
  })

  const repo = await gh.execute("repos.get", { owner: "acme", name: "api" })

  assert.equal(repo.full_name, "acme/api")
  assert.equal(repo.description, null)
  assert.equal(seen?.url, "https://api.github.com/repos/acme/api")
  assert.equal(seen?.headers.get("authorization"), "Bearer ghp_test")
  assert.equal(seen?.headers.get("user-agent"), "connector-kit")
})

test("repos.get maps a missing repo to not_found", async () => {
  const { gh } = githubWith(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }))
  await assert.rejects(
    () => gh.execute("repos.get", { owner: "acme", name: "missing" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found",
  )
})

test("repos.get cannot be steered to another endpoint with '..'", async () => {
  const { gh, calls } = githubWith(() => new Response("{}", { status: 200 }))
  await assert.rejects(
    () => gh.execute("repos.get", { owner: "..", name: "user" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "invalid_input",
  )
  assert.equal(calls.length, 0)
})
