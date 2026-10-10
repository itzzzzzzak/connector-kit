import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import netlify from "./index.js"

const deploy = { id: "d1", site_id: "s1", state: "ready", name: "mysite", ssl_url: "https://mysite.netlify.app", branch: "main", commit_ref: "abc123", error_message: null, created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:01:00Z" }
const site = { id: "s1", name: "mysite", state: "current", ssl_url: "https://mysite.netlify.app", custom_domain: null, published_deploy: deploy }
const link = (rel: string, url: string) => ({ link: `<${url}>; rel="${rel}"` })

standardTests(netlify, { action: "user.get", input: {}, ok: { id: "u1", full_name: "Ada", email: "ada@x.dev", site_count: 3 } })
standardTests(netlify, { action: "sites.list", input: {}, ok: [site], badInput: { filter: "everything" } })
standardTests(netlify, { action: "sites.get", input: { site_id: "s1" }, ok: site, badInput: { site_id: 5 } })
standardTests(netlify, { action: "sites.deploys.list", input: { site_id: "s1" }, ok: [deploy], badInput: { site_id: 5 } })
standardTests(netlify, { action: "deploys.get", input: { deploy_id: "d1" }, ok: deploy, badInput: { deploy_id: 5 } })
standardTests(netlify, { action: "sites.builds.create", input: { site_id: "s1" }, ok: { id: "b1", deploy_id: "d1", done: false }, badInput: { site_id: 5 } })

test("lists use per_page, follow the Link header, and keep the filters; the token follows the link", async () => {
  const { kit, conn, calls } = harness(netlify, (c) =>
    c.url.searchParams.get("page") === "2" ? json([{ ...deploy, id: "d2" }]) : json([deploy], 200, link("next", "https://api.netlify.com/api/v1/sites/s1/deploys?page=2&per_page=30&branch=main")),
  )
  const ids: string[] = []
  for await (const d of kit.paginate(conn, "sites.deploys.list", { site_id: "s1", branch: "main", production: true })) ids.push(d.id)
  assert.deepEqual(ids, ["d1", "d2"])
  assert.equal(calls[0]!.url.pathname, "/api/v1/sites/s1/deploys")
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "30")
  assert.equal(calls[0]!.url.searchParams.get("production"), "true")
  assert.equal(calls[1]!.header("authorization"), "Bearer test-token")
})

test("the page size is capped at Netlify's 100", async () => {
  const { conn, calls } = harness(netlify, () => json([]))
  await conn.execute("sites.list", { pageSize: 10_000 })
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "100")
})

test("a parameter whose name has a hyphen (deploy-previews) is sent as the provider spells it", async () => {
  const { conn, calls } = harness(netlify, () => json([]))
  await conn.execute("sites.deploys.list", { site_id: "s1", "deploy-previews": true })
  assert.equal(calls[0]!.url.searchParams.get("deploy-previews"), "true")
})

test("a null commit and a null error are accepted (a manual deploy has neither)", async () => {
  const { conn } = harness(netlify, () => json({ ...deploy, commit_ref: null, branch: null, error_message: null }))
  assert.equal((await conn.execute("deploys.get", { deploy_id: "d1" })).commit_ref, null)
})

test("sites.builds.create sends its options in the QUERY string and no body, and is never retried", async () => {
  const { conn, calls } = harness(netlify, () => json({ id: "b1", deploy_id: "d1", done: false }), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("sites.builds.create", { site_id: "s1", branch: "main", clear_cache: true })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/api/v1/sites/s1/builds")
  assert.equal(calls[0]!.url.searchParams.get("branch"), "main")
  assert.equal(calls[0]!.url.searchParams.get("clear_cache"), "true")
  assert.equal(calls[0]!.init.body, undefined)
})

test("Netlify's rate-limit headers are understood when the budget is exhausted", async () => {
  const reset = Math.floor(Date.now() / 1000) + 20
  const { conn } = harness(netlify, () => json({}, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }))
  await assert.rejects(() => conn.execute("sites.list", {}), (e: unknown) => {
    const err = e as { code?: string; retryAfter?: number }
    return err.code === "rate_limited" && err.retryAfter !== undefined && err.retryAfter >= 15 && err.retryAfter <= 21
  })
})
