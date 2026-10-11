import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import { generatedActions } from "./generated/index.js"
import pagerduty from "./index.js"

const incident = { id: "Q1", incident_number: 42, title: "DB down", status: "triggered", urgency: "high", created_at: "2026-10-01T00:00:00Z", resolved_at: null, service: { id: "S1", summary: "Database", html_url: "https://x.pagerduty.com/services/S1" }, assignments: [{ assignee: { id: "U1", summary: "Ada" } }], priority: null }
const page = (key: string, items: unknown[], more = false) => ({ [key]: items, limit: 30, offset: 0, more, total: null })

standardTests(pagerduty, { action: "incidents.list", input: {}, ok: page("incidents", [incident]), badInput: { statuses: ["on-fire"] } })
standardTests(pagerduty, { action: "incidents.get", input: { id: "Q1" }, ok: { incident }, badInput: { id: 5 } })
standardTests(pagerduty, { action: "services.list", input: {}, ok: page("services", [{ id: "S1", name: "Database", status: "active" }]), badInput: { query: 5 } })
standardTests(pagerduty, { action: "oncalls.list", input: {}, ok: page("oncalls", [{ user: { id: "U1", summary: "Ada" }, escalation_level: 1, schedule: null, start: null, end: null }]), badInput: { earliest: "yes" } })
standardTests(pagerduty, { action: "schedules.list", input: {}, ok: page("schedules", [{ id: "P1", name: "Primary", time_zone: "UTC" }]), badInput: { query: 5 } })
standardTests(pagerduty, { action: "escalationPolicies.list", input: {}, ok: page("escalation_policies", [{ id: "E1", name: "Default", num_loops: 2 }]), badInput: { query: 5 } })
standardTests(pagerduty, { action: "users.list", input: {}, ok: page("users", [{ id: "U1", name: "Ada", email: "a@x.dev", role: "admin" }]), badInput: { query: 5 } })

test("auth is 'Token token=KEY' (not Bearer) and the v2 Accept header is sent", async () => {
  const { conn, calls } = harness(pagerduty, () => json(page("incidents", [])), { credentials: { token: "PDKEY" } })
  await conn.execute("incidents.list", {})
  assert.equal(calls[0]!.header("authorization"), "Token token=PDKEY")
  assert.equal(calls[0]!.header("accept"), "application/vnd.pagerduty+json;version=2")
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, "https://api.pagerduty.com/incidents")
})

test("array filters use PagerDuty's bracket spelling, repeated", async () => {
  const { conn, calls } = harness(pagerduty, () => json(page("incidents", [])))
  await conn.execute("incidents.list", { statuses: ["triggered", "acknowledged"], urgencies: ["high"], service_ids: ["S1", "S2"], since: "2026-10-01T00:00:00Z" })
  const q = calls[0]!.url.searchParams
  assert.deepEqual(q.getAll("statuses[]"), ["triggered", "acknowledged"])
  assert.deepEqual(q.getAll("urgencies[]"), ["high"])
  assert.deepEqual(q.getAll("service_ids[]"), ["S1", "S2"])
  assert.equal(q.has("statuses"), false, "the unbracketed spelling must not be sent")
  assert.equal(q.get("since"), "2026-10-01T00:00:00Z")
  assert.equal(q.get("limit"), "30")
})

test("offset paging follows 'more', keeps the filters, and stops when more is false", async () => {
  const { kit, conn, calls } = harness(pagerduty, (c) => {
    const offset = Number(c.url.searchParams.get("offset") ?? 0)
    return json(page("incidents", [{ ...incident, id: `Q${offset}` }, { ...incident, id: `Q${offset + 1}` }], offset < 60))
  })
  const ids: string[] = []
  let n = 0
  for await (const i of kit.paginate(conn, "incidents.list", { statuses: ["triggered"], pageSize: 30 })) {
    ids.push(i.id)
    if (++n > 20) break
  }
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("offset")), [null, "30", "60"])
  assert.ok(calls.every((c) => c.url.searchParams.getAll("statuses[]").join() === "triggered"))
})

test("the page size is capped at 100", async () => {
  const { conn, calls } = harness(pagerduty, () => json(page("users", [])))
  await conn.execute("users.list", { pageSize: 5000 })
  assert.equal(calls[0]!.url.searchParams.get("limit"), "100")
})

test("null fields PagerDuty really sends (no priority, no resolved time, no schedule) are accepted", async () => {
  const { conn } = harness(pagerduty, () => json({ incident }))
  const result = await conn.execute("incidents.get", { id: "Q1" })
  assert.equal(result.incident.priority, null)
  assert.equal(result.incident.resolved_at, null)
})

test("this connector cannot change anything: every action is a read (the hand-written ones; generated writes exist but need --allow-writes through MCP)", () => {
  assert.ok(Object.entries(pagerduty.actions).filter(([name]) => !(name in generatedActions)).every(([, a]) => a.effect === "read"))
})

test("an incident id that tries to change the path is rejected before anything is sent", async () => {
  const { conn, calls } = harness(pagerduty, () => json({ incident }))
  await assert.rejects(() => conn.execute("incidents.get", { id: ".." }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})
