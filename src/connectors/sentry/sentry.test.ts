import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import sentry from "./index.js"

const connect = { variables: { region: "us" } }
const issue = { id: "1234", shortId: "WEB-1A", title: "TypeError: x is undefined", culprit: "app/main.js", level: "error", status: "unresolved", project: { id: "7", slug: "web", name: "Web" }, count: "1500", userCount: 230, firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-09T00:00:00Z", isUnhandled: true, assignedTo: null, metadata: { type: "TypeError" } }
const event = { id: "e1", eventID: "abc123", title: "TypeError", message: "x is undefined", dateCreated: "2026-10-09T00:00:00Z", tags: [{ key: "browser", value: "Chrome" }], user: { id: "u1" } }
const next = (cursor: string, results = true) => ({ link: `<https://us.sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://us.sentry.io/api/0/x/?cursor=${cursor}>; rel="next"; results="${results}"; cursor="${cursor}"` })

standardTests(sentry, { action: "organizations.list", input: {}, ok: [{ id: "1", slug: "acme", name: "Acme" }], badInput: { query: 5 }, connect })
standardTests(sentry, { action: "projects.list", input: { organization: "acme" }, ok: [{ id: "7", slug: "web", name: "Web", platform: "javascript" }], badInput: { organization: 5 }, connect })
standardTests(sentry, { action: "issues.list", input: { organization: "acme" }, ok: [issue], badInput: { organization: "acme", sort: "random" }, connect })
standardTests(sentry, { action: "issues.get", input: { organization: "acme", issue_id: "1234" }, ok: issue, badInput: { organization: "acme", issue_id: "not-a-number" }, connect })
standardTests(sentry, { action: "issues.events.list", input: { organization: "acme", issue_id: "1234" }, ok: [event], badInput: { organization: "acme", issue_id: "x" }, connect })
standardTests(sentry, { action: "issues.events.get", input: { organization: "acme", issue_id: "1234", event_id: "latest" }, ok: { ...event, entries: [{ type: "exception", data: {} }] }, badInput: { organization: "acme", issue_id: "1234", event_id: "../x" }, connect })

const h = (respond: Parameters<typeof harness>[1], opts = {}) => harness(sentry, respond, { ...connect, ...opts })

test("requests go to the region's host with a Bearer token", async () => {
  const { conn, calls } = h(() => json([]), { credentials: { token: "sntrys_abc" } })
  await conn.execute("organizations.list", {})
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, "https://us.sentry.io/api/0/organizations/")
  assert.equal(calls[0]!.header("authorization"), "Bearer sntrys_abc")
})

test("only the documented regions are accepted, and a hostile region never reaches the network", () => {
  for (const region of ["eu", "evil.com/x", "us.evil.com", "", "US"]) assert.throws(() => harness(sentry, () => json({}), { variables: { region } }), /one of: us, de/, region)
  harness(sentry, () => json({}), { variables: { region: "de" } })
})

test("issues.list: the query, projects and period are sent; limit is the page-size parameter", async () => {
  const { conn, calls } = h(() => json([issue]))
  await conn.execute("issues.list", { organization: "acme", query: "is:unresolved level:error", project: [7, 9], environment: ["production"], statsPeriod: "24h", sort: "freq", pageSize: 10 })
  const q = calls[0]!.url.searchParams
  assert.equal(calls[0]!.url.pathname, "/api/0/organizations/acme/issues/")
  assert.equal(q.get("query"), "is:unresolved level:error")
  assert.deepEqual(q.getAll("project"), ["7", "9"])
  assert.deepEqual(q.getAll("environment"), ["production"])
  assert.equal(q.get("statsPeriod"), "24h")
  assert.equal(q.get("limit"), "10")
  assert.equal(q.has("per_page"), false)
})

test("paging follows the cursor attribute of rel=next, stops at results=false, and keeps the filters", async () => {
  const { kit, conn, calls } = h((c) => {
    const cursor = c.url.searchParams.get("cursor")
    if (cursor === null) return json([issue], 200, next("0:30:0"))
    if (cursor === "0:30:0") return json([{ ...issue, id: "2" }], 200, next("0:60:0"))
    return json([{ ...issue, id: "3" }], 200, next("0:90:0", false))
  })
  const ids: string[] = []
  for await (const i of kit.paginate(conn, "issues.list", { organization: "acme", query: "is:unresolved" })) ids.push(i.id)
  assert.deepEqual(ids, ["1234", "2", "3"])
  assert.equal(calls.length, 3)
  assert.ok(calls.every((c) => c.url.searchParams.get("query") === "is:unresolved" && c.url.origin === "https://us.sentry.io"))
})

test("a Link header that names ANOTHER host is harmless: only its cursor is used, on our own request", async () => {
  const { conn, calls } = h(() => json([issue], 200, { link: '<https://attacker.example.net/steal>; rel="next"; results="true"; cursor="0:30:0"' }))
  const page = await conn.execute("issues.list", { organization: "acme" })
  assert.equal(page.nextCursor, "0:30:0")
  await conn.execute("issues.list", { organization: "acme", cursor: page.nextCursor! })
  assert.equal(calls[1]!.url.origin, "https://us.sentry.io")
  assert.equal(calls[1]!.url.searchParams.get("cursor"), "0:30:0")
})

test("issue and event ids are path-safe: anything that could change the path is rejected before sending", async () => {
  const { conn, calls } = h(() => json(issue))
  for (const issue_id of ["..", "1/../2", "12 34", "1?x=1"]) await assert.rejects(() => conn.execute("issues.get", { organization: "acme", issue_id }), (e: unknown) => (e as { code?: string }).code === "invalid_input", issue_id)
  await assert.rejects(() => conn.execute("issues.events.get", { organization: "acme", issue_id: "1", event_id: "a/b" }))
  await assert.rejects(() => conn.execute("issues.get", { organization: "..", issue_id: "1" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("the 'latest' event can be fetched with its stack trace", async () => {
  const { conn, calls } = h(() => json({ ...event, entries: [{ type: "exception", data: { values: [{ type: "TypeError" }] } }] }))
  const result = await conn.execute("issues.events.get", { organization: "acme", issue_id: "1234", event_id: "latest" })
  assert.equal(calls[0]!.url.pathname, "/api/0/organizations/acme/issues/1234/events/latest/")
  assert.equal(result.entries?.[0]?.type, "exception")
})

test("every action is a read: this connector cannot change anything in Sentry", () => {
  assert.ok(Object.values(sentry.actions).every((a) => a.effect === "read"))
})
