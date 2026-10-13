import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import posthog from "./index.js"

const connect = { variables: { host: "us.posthog.com" }, credentials: { token: "phx_secretkey" } }
const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(posthog, { ...c, connect })
const page = (results: unknown[], nextUrl: string | null = null) => ({ count: results.length, next: nextUrl, previous: null, results })
const flag = { id: 7, key: "new-nav", name: "New nav", active: true, deleted: false }
const insight = { id: 3, short_id: "abc123", name: "Signups", filters: {} }
const P = 12

std({ action: "me.get", input: {}, ok: { id: 1, email: "ak@example.com" } })
std({ action: "projects.list", input: {}, ok: page([{ id: P, name: "Prod" }]), badInput: { pageSize: 0 } })
std({ action: "persons.list", input: { projectId: P, email: "a@b.co" }, ok: page([{ id: "p1", distinct_ids: ["u1"] }]), badInput: { projectId: "12" } })
std({ action: "events.list", input: { projectId: P, event: "$pageview" }, ok: page([{ id: "e1", event: "$pageview" }]), badInput: { projectId: P, after: "yesterday" } })
std({ action: "insights.list", input: { projectId: P }, ok: page([insight]), badInput: { projectId: -1 } })
std({ action: "insight.get", input: { projectId: P, insightId: 3 }, ok: insight, badInput: { projectId: P, insightId: "x" } })
std({ action: "query.run", input: { projectId: P, query: "SELECT 1 LIMIT 1" }, ok: { columns: ["1"], results: [[1]] }, badInput: { projectId: P, query: "" } })
std({ action: "featureFlags.list", input: { projectId: P }, ok: page([flag]), badInput: { projectId: 0 } })
std({ action: "featureFlag.get", input: { projectId: P, flagId: 7 }, ok: flag, badInput: { projectId: P, flagId: 0 } })
std({ action: "featureFlag.create", input: { projectId: P, key: "new-nav" }, ok: flag, badInput: { projectId: P, key: "has space" } })
std({ action: "featureFlag.update", input: { projectId: P, flagId: 7, active: false }, ok: flag, badInput: { projectId: P, flagId: 7 } })
std({ action: "featureFlag.delete", input: { projectId: P, flagId: 7 }, ok: { ...flag, deleted: true }, badInput: { projectId: P, flagId: "7" } })

test("the personal key is sent as a bearer token to the chosen cloud host", async () => {
  const { conn, calls } = harness(posthog, () => json(page([])), { variables: { host: "eu.posthog.com" }, credentials: { token: "phx_secretkey" } })
  await conn.execute("projects.list", {})
  assert.equal(calls[0]!.url.host, "eu.posthog.com")
  assert.equal(calls[0]!.header("authorization"), "Bearer phx_secretkey")
})

test("a host outside the closed list is refused", () => {
  assert.throws(() => harness(posthog, () => json({}), { variables: { host: "evil.example.com" }, credentials: { token: "phx_k" } }))
})

test("the project id goes in the path and not in the query", async () => {
  const { conn, calls } = harness(posthog, () => json(page([])), connect)
  await conn.execute("persons.list", { projectId: P, distinctId: "u1", pageSize: 5 })
  assert.equal(calls[0]!.url.pathname, `/api/projects/${P}/persons/`)
  assert.equal(calls[0]!.url.searchParams.get("distinct_id"), "u1")
  assert.equal(calls[0]!.url.searchParams.get("limit"), "5")
  assert.equal(calls[0]!.url.searchParams.get("projectId"), null)
})

test("a list returns the next page link as the cursor, and null on the last page", async () => {
  const link = `https://us.posthog.com/api/projects/${P}/events/?limit=1&offset=1`
  const more = harness(posthog, () => json(page([{ id: "e1", event: "x" }], link)), connect)
  assert.equal(((await more.conn.execute("events.list", { projectId: P, pageSize: 1 })) as { nextCursor: string | null }).nextCursor, link)
  const last = harness(posthog, () => json(page([{ id: "e1", event: "x" }])), connect)
  assert.equal(((await last.conn.execute("events.list", { projectId: P })) as { nextCursor: string | null }).nextCursor, null)
})

test("query.run wraps the text in a HogQL query object", async () => {
  const { conn, calls } = harness(posthog, () => json({ columns: [], results: [] }), connect)
  await conn.execute("query.run", { projectId: P, query: "SELECT 1 LIMIT 1" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.deepEqual(calls[0]!.body, { query: { kind: "HogQLQuery", query: "SELECT 1 LIMIT 1" } })
})

test("featureFlag.create defaults to active at 0 percent, and delete only marks the flag deleted", async () => {
  const { conn, calls } = harness(posthog, () => json(flag), connect)
  await conn.execute("featureFlag.create", { projectId: P, key: "new-nav" })
  assert.deepEqual(calls[0]!.body, { key: "new-nav", active: true, filters: { groups: [{ properties: [], rollout_percentage: 0 }] } })
  await conn.execute("featureFlag.delete", { projectId: P, flagId: 7 })
  assert.equal(calls[1]!.init.method, "PATCH")
  assert.deepEqual(calls[1]!.body, { deleted: true })
})

test("featureFlag.update sends only the fields given", async () => {
  const { conn, calls } = harness(posthog, () => json(flag), connect)
  await conn.execute("featureFlag.update", { projectId: P, flagId: 7, active: false })
  assert.deepEqual(calls[0]!.body, { active: false })
})

test("a 403 for a key without the scope is a permission error, and the key is not in it", async () => {
  const { conn } = harness(posthog, () => json({ detail: "API key missing required scope 'feature_flag:read'" }, 403), connect)
  await assert.rejects(() => conn.execute("featureFlags.list", { projectId: P }), (e: unknown) => !(JSON.stringify(e) + (e as Error).message).includes("phx_secretkey"))
})
