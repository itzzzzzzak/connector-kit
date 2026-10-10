import assert from "node:assert/strict"
import { test } from "node:test"
import calendly from "./index.js"
import { harness, json, standardTests } from "../../connector-harness.test.js"

const me = { resource: { uri: "https://api.calendly.com/users/U1", name: "Ada", email: "ada@acme.dev", current_organization: "https://api.calendly.com/organizations/O1", timezone: "Europe/London" } }
const event = { uri: "https://api.calendly.com/scheduled_events/E1", name: "Intro call", status: "active", start_time: "2026-11-01T10:00:00Z", end_time: "2026-11-01T10:30:00Z", event_type: "https://api.calendly.com/event_types/T1" }
const page = (collection: unknown[], next?: string) => ({ collection, pagination: { count: collection.length, next_page: next ? "https://api.calendly.com/x" : null, next_page_token: next ?? null } })
const USER = "https://api.calendly.com/users/U1"

standardTests(calendly, { action: "users.me", input: {}, ok: me }) // takes no input, so there is no "bad input" case
standardTests(calendly, { action: "eventTypes.list", input: { user: USER }, ok: page([{ uri: "https://api.calendly.com/event_types/T1", name: "Intro", active: true, duration: 30 }]), badInput: { user: 5 } })
standardTests(calendly, { action: "scheduledEvents.list", input: { user: USER }, ok: page([event]), badInput: { user: 5 } })
standardTests(calendly, { action: "scheduledEvents.get", input: { uuid: "E1" }, ok: { resource: event }, badInput: { uuid: 5 } })
standardTests(calendly, { action: "scheduledEvents.invitees.list", input: { uuid: "E1" }, ok: page([{ uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", email: "bo@x.dev", status: "active" }]), badInput: { uuid: 5 } })
standardTests(calendly, { action: "scheduledEvents.cancel", input: { uuid: "E1", reason: "conflict" }, ok: { resource: { canceled_by: "Ada", canceler_type: "host" } }, badInput: { uuid: 5 } })

test("users.me returns the URIs the other calls need", async () => {
  const { conn, calls } = harness(calendly, () => json(me))
  const result = await conn.execute("users.me", {})
  assert.equal(result.resource.current_organization, "https://api.calendly.com/organizations/O1")
  assert.equal(calls[0]!.url.toString(), "https://api.calendly.com/users/me")
  assert.equal(calls[0]!.header("authorization"), "Bearer test-token")
})

test("lists use count/page_token, cap the page at 100, and follow pagination.next_page_token with the filters kept", async () => {
  const { kit, conn, calls } = harness(calendly, (c) => json(c.url.searchParams.has("page_token") ? page([{ ...event, uri: "e2" }]) : page([event], "TOKEN2")))
  const uris: string[] = []
  for await (const e of kit.paginate(conn, "scheduledEvents.list", { user: USER, status: "active", min_start_time: "2026-11-01T00:00:00Z", pageSize: 1000 })) uris.push(e.uri)
  assert.deepEqual(uris, [event.uri, "e2"])
  assert.equal(calls[0]!.url.searchParams.get("count"), "100")
  assert.equal(calls[1]!.url.searchParams.get("page_token"), "TOKEN2")
  assert.ok(calls.every((c) => c.url.searchParams.get("user") === USER && c.url.searchParams.get("status") === "active"))
})

test("the default page size is 20 (Calendly's own default)", async () => {
  const { conn, calls } = harness(calendly, () => json(page([])))
  await conn.execute("eventTypes.list", { organization: "https://api.calendly.com/organizations/O1" })
  assert.equal(calls[0]!.url.searchParams.get("count"), "20")
  assert.equal(calls[0]!.url.searchParams.get("organization"), "https://api.calendly.com/organizations/O1")
})

test("a null next_page_token means the last page", async () => {
  const { conn } = harness(calendly, () => json(page([event])))
  assert.equal((await conn.execute("scheduledEvents.list", { user: USER })).nextCursor, null)
})

test("scheduledEvents.invitees.list puts the uuid in the path and the filters in the query", async () => {
  const { conn, calls } = harness(calendly, () => json(page([])))
  await conn.execute("scheduledEvents.invitees.list", { uuid: "E1", status: "active", email: "bo@x.dev" })
  assert.equal(calls[0]!.url.pathname, "/scheduled_events/E1/invitees")
  assert.equal(calls[0]!.url.searchParams.get("email"), "bo@x.dev")
})

test("cancel is a destructive POST with an optional reason, the uuid only in the path, and is never retried", async () => {
  const { conn, calls } = harness(calendly, () => json({ resource: { canceled_by: "Ada" } }, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("scheduledEvents.cancel", { uuid: "E1", reason: "conflict" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/scheduled_events/E1/cancellation")
  assert.deepEqual(calls[0]!.body, { reason: "conflict" })
  assert.equal(calendly.actions["scheduledEvents.cancel"].effect, "destructive")
})

test("OAuth uses Calendly's discovery-document endpoints", () => {
  assert.equal(calendly.auth.type, "oauth2")
  if (calendly.auth.type === "oauth2") {
    assert.equal(calendly.auth.authorizeUrl, "https://calendly.com/oauth/authorize")
    assert.equal(calendly.auth.tokenUrl, "https://calendly.com/oauth/token")
  }
})
