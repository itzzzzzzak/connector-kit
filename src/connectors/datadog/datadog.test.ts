import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import datadog from "./index.js"

const connect = { variables: { site: "datadoghq.com" }, credentials: { token: "api123:app456" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(datadog, respond, connect)
const monitor = { id: 42, name: "High CPU", type: "metric alert", query: "avg(last_5m):avg:system.cpu.user{*} > 90", overall_state: "OK", tags: ["team:core"] }
const logEvent = { id: "AAA", type: "log", attributes: { timestamp: "2026-10-12T10:00:00Z", service: "web", status: "error", message: "boom", tags: [] } }
const std = (c: Omit<Parameters<typeof standardTests>[1], "connect" | "unauthorizedStatus">) => standardTests(datadog, { ...c, connect, unauthorizedStatus: 403 })

std({ action: "keys.validate", input: {}, ok: { valid: true } })
std({ action: "metrics.query", input: { query: "avg:system.cpu.user{*}", from: 1760000000, to: 1760003600 }, ok: { status: "ok", series: [{ metric: "system.cpu.user", pointlist: [[1760000000000, 1.5]] }] }, badInput: { query: "x", from: "now", to: 5 } })
std({ action: "monitors.list", input: {}, ok: [monitor], badInput: { pageSize: "x" } })
std({ action: "monitors.search", input: { query: "status:alert" }, ok: { monitors: [monitor], metadata: { page: 0, page_count: 1, per_page: 30, total_count: 1 } }, badInput: { sort: 5 } })
std({ action: "monitor.get", input: { monitor_id: 42 }, ok: monitor, badInput: { monitor_id: "42" } })
std({ action: "logs.search", input: { query: "service:web status:error" }, ok: { data: [logEvent], meta: { page: { after: "c2" } } }, badInput: { sort: "newest" } })
std({ action: "events.search", input: { query: "source:alert" }, ok: { data: [{ id: "E1", type: "event" }], meta: { page: {} } }, badInput: { sort: "newest" } })
std({ action: "incidents.list", input: {}, ok: { data: [{ id: "I1", type: "incidents", attributes: { title: "Outage", state: "active" } }], meta: { pagination: { offset: 0, size: 25, total: 1 } } }, badInput: { pageSize: "x" } })
std({ action: "dashboards.list", input: {}, ok: { dashboards: [{ id: "abc-def-ghi", title: "Overview" }] }, badInput: { filter_shared: "yes" } })
std({ action: "dashboard.get", input: { dashboard_id: "abc-def-ghi" }, ok: { id: "abc-def-ghi", title: "Overview", widgets: [] }, badInput: { dashboard_id: "../x" } })
std({ action: "hosts.list", input: {}, ok: { host_list: [{ name: "web-1", id: 1 }], total_matching: 1, total_returned: 1 }, badInput: { sort_dir: "up" } })
std({ action: "slos.list", input: {}, ok: { data: [{ id: "s1", name: "Latency" }] }, badInput: { pageSize: "x" } })

test("both keys travel in their own headers, to the site's api host", async () => {
  const { conn, calls } = h(() => json({ valid: true }))
  await conn.execute("keys.validate", {})
  assert.equal(calls[0]!.url.toString(), "https://api.datadoghq.com/api/v1/validate")
  assert.equal(calls[0]!.header("dd-api-key"), "api123")
  assert.equal(calls[0]!.header("dd-application-key"), "app456")
})

test("another region's site is accepted, and a site that is not on the list is not", async () => {
  const eu = harness(datadog, () => json({ valid: true }), { variables: { site: "datadoghq.eu" }, credentials: { token: "a:b" } })
  await eu.conn.execute("keys.validate", {})
  assert.equal(eu.calls[0]!.url.host, "api.datadoghq.eu")
  for (const site of ["evil.com", "datadoghq.com.evil.com", "datadoghq.com/", ""]) assert.throws(() => harness(datadog, () => json({}), { variables: { site }, credentials: { token: "a:b" } }), /not valid/, site)
})

test("a monitor list always asks for page 0, because Datadog returns everything when page is missing", async () => {
  const { conn, calls } = h(() => json([monitor, monitor]))
  const first = (await conn.execute("monitors.list", { name: "CPU", pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("page"), "0")
  assert.equal(calls[0]!.url.searchParams.get("page_size"), "2")
  assert.equal(calls[0]!.url.searchParams.get("name"), "CPU")
  assert.equal(first.nextCursor, "1")
  await conn.execute("monitors.list", { cursor: "1", pageSize: 2 })
  assert.equal(calls[1]!.url.searchParams.get("page"), "1")
})

test("a log search is a POST whose filter, sort and page go in the body, and it pages by meta.page.after", async () => {
  const { conn, calls } = h((call) => json((call.body as { page: { cursor?: string } }).page.cursor ? { data: [logEvent], meta: { page: {} } } : { data: [logEvent], meta: { page: { after: "c2" } } }))
  const first = (await conn.execute("logs.search", { query: "service:web", from: "now-1h", sort: "-timestamp", indexes: ["main"], pageSize: 10 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.search, "")
  assert.deepEqual(calls[0]!.body, { filter: { query: "service:web", from: "now-1h", to: "now", indexes: ["main"] }, sort: "-timestamp", page: { limit: 10 } })
  assert.equal(first.nextCursor, "c2")
  const second = (await conn.execute("logs.search", { query: "service:web", from: "now-1h", cursor: "c2", pageSize: 10 })) as { nextCursor: string | null }
  assert.deepEqual((calls[1]!.body as { page: unknown }).page, { limit: 10, cursor: "c2" })
  assert.equal(second.nextCursor, null)
})

test("a search with no query is a search for everything over the last 15 minutes, never more", async () => {
  const { conn, calls } = h(() => json({ data: [], meta: { page: {} } }))
  await conn.execute("logs.search", {})
  assert.deepEqual((calls[0]!.body as { filter: unknown }).filter, { query: "*", from: "now-15m", to: "now" })
})

test("a read-only search is retried after a 5xx like any read", async () => {
  let n = 0
  const retry = { maxRetries: 2, sleep: async () => {}, random: () => 0 }
  const { conn, calls } = harness(datadog, () => (++n === 1 ? json({}, 503) : json({ data: [], meta: { page: {} } })), { ...connect, retry })
  await conn.execute("logs.search", { query: "status:error" })
  assert.equal(calls.length, 2)
})

test("a metric query sends epoch seconds in the query string, and the window must be forwards", async () => {
  const { conn, calls } = h(() => json({ status: "ok", series: [] }))
  await conn.execute("metrics.query", { query: "avg:system.load.1{*}", from: 1760000000, to: 1760003600 })
  assert.equal(calls[0]!.url.searchParams.get("from"), "1760000000")
  assert.equal(calls[0]!.url.searchParams.get("query"), "avg:system.load.1{*}")
  await assert.rejects(() => conn.execute("metrics.query", { query: "x", from: 1760003600, to: 1760000000 }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("a 429 says how long the window has left (seconds), and a 403 means the keys were rejected", async () => {
  const limited = h(() => json({ errors: ["Rate limit"] }, 429, { "x-ratelimit-reset": "17" }))
  await assert.rejects(() => limited.conn.execute("monitors.list", {}), (e: unknown) => {
    const err = e as { code?: string; retryAfter?: number; retryable?: boolean }
    return err.code === "rate_limited" && err.retryAfter === 17 && err.retryable === true
  })
  const forbidden = h(() => json({ errors: ["Forbidden"] }, 403))
  await assert.rejects(() => forbidden.conn.execute("monitors.list", {}), (e: unknown) => (e as { code?: string }).code === "auth_expired")
})

test("the generated half is large, stays under the tool-name limit, and every DELETE is destructive", () => {
  const actions = datadog.actions as Record<string, { effect: string; method: string; path: string }>
  const names = Object.keys(actions)
  assert.ok(names.length > 1500, `${names.length} actions`)
  for (const name of names) assert.ok(`datadog_${name}`.replace(".", "_").length <= 64, name)
  for (const [name, action] of Object.entries(actions)) if (action.method === "DELETE") assert.equal(action.effect, "destructive", name)
  assert.equal(names.some((n) => actions[n]!.path.startsWith("/api/unstable/")), false)
})
