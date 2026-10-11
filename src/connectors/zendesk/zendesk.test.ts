import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json } from "../../connector-harness.test.js"
import zendesk from "./index.js"

const V = { variables: { subdomain: "acme" }, credentials: { token: "me@acme.dev/token:APITOKEN" } }
const ticket = { id: 35436, subject: "Printer on fire", description: "Help!", status: "open", priority: "high", type: "incident", requester_id: 20978392, assignee_id: null, group_id: 98738, organization_id: null, tags: ["printer"], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", url: "https://acme.zendesk.com/api/v2/tickets/35436.json" }
const cursor = (key: string, items: unknown[], next?: string) => ({ [key]: items, meta: { has_more: Boolean(next), after_cursor: next ? "AFTER" : null }, links: { next: next ?? "https://acme.zendesk.com/api/v2/stale" } })
const h = (respond: Parameters<typeof harness>[1], opts = {}) => harness(zendesk, respond, { ...V, ...opts })

test("every action works when connected with a subdomain: failure paths", async () => {
  const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; bad?: Record<string, unknown> }> = [
    { action: "users.me", input: {}, ok: { user: { id: 1, name: "Ada", email: "a@acme.dev", role: "admin" } } },
    { action: "tickets.list", input: {}, ok: cursor("tickets", [ticket]), bad: { sort_by: "colour" } },
    { action: "tickets.get", input: { ticket_id: 35436 }, ok: { ticket }, bad: { ticket_id: "abc" } },
    { action: "tickets.comments.list", input: { ticket_id: 35436 }, ok: cursor("comments", [{ id: 1, body: "hi", public: true }]), bad: { ticket_id: 0 } },
    { action: "search", input: { query: "type:ticket" }, ok: { results: [{ id: 1, result_type: "ticket", subject: "x" }], next_page: null, count: 1 }, bad: { query: "" } },
    { action: "tickets.create", input: { subject: "s", comment: "c" }, ok: { ticket }, bad: { subject: "" } },
    { action: "tickets.update", input: { ticket_id: 1, status: "solved" }, ok: { ticket }, bad: { ticket_id: -1 } },
  ]
  for (const c of cases) {
    const ok = h(() => json(c.ok))
    await ok.conn.execute(c.action as never, c.input as never)
    for (const [status, code] of [[404, "not_found"], [401, "auth_expired"]] as const) {
      const bad = h(() => json({}, status))
      await assert.rejects(() => bad.conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string }).code === code, `${c.action} ${status}`)
    }
    const limited = h(() => json({}, 429, { "retry-after": "9" }))
    await assert.rejects(() => limited.conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string; retryAfter?: number }).code === "rate_limited" && (e as { retryAfter?: number }).retryAfter === 9, `${c.action} 429`)
    const malformed = h(() => new Response("<html>", { status: 200 }))
    await assert.rejects(() => malformed.conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string }).code === "upstream_error", `${c.action} malformed`)
    if (c.bad) {
      const none = h(() => json(c.ok))
      await assert.rejects(() => none.conn.execute(c.action as never, c.bad as never), (e: unknown) => (e as { code?: string }).code === "invalid_input", `${c.action} bad input`)
      assert.equal(none.calls.length, 0)
    }
  }
})

test("requests go to the tenant's own host with HTTP Basic using '{email}/token:{api_token}'", async () => {
  const { conn, calls } = h(() => json({ user: { id: 1 } }))
  await conn.execute("users.me", {})
  assert.equal(calls[0]!.url.toString(), "https://acme.zendesk.com/api/v2/users/me")
  assert.equal(calls[0]!.header("authorization"), `Basic ${Buffer.from("me@acme.dev/token:APITOKEN").toString("base64")}`)
})

test("a hostile subdomain is refused before any request", () => {
  for (const subdomain of ["evil.com/x", "acme.evil.com", "a@b", ""]) assert.throws(() => harness(zendesk, () => json({}), { ...V, variables: { subdomain } }), /not valid/, subdomain)
})

test("two tenants never see each other's host or credentials", async () => {
  const seen: string[] = []
  const { kit } = h((c) => (seen.push(`${c.url.host}|${c.header("authorization")}`), json({ user: { id: 1 } })))
  const a = kit.connect(zendesk, { connectionId: "a", credentials: { token: "a@a.dev/token:AAA" }, variables: { subdomain: "alpha" } })
  const b = kit.connect(zendesk, { connectionId: "b", credentials: { token: "b@b.dev/token:BBB" }, variables: { subdomain: "beta" } })
  await a.execute("users.me", {})
  await b.execute("users.me", {})
  assert.deepEqual(seen, [
    `alpha.zendesk.com|Basic ${Buffer.from("a@a.dev/token:AAA").toString("base64")}`,
    `beta.zendesk.com|Basic ${Buffer.from("b@b.dev/token:BBB").toString("base64")}`,
  ])
})

test("tickets.list opts into cursor paging with page[size], follows links.next only while has_more, and keeps sorting", async () => {
  const { kit, conn, calls } = h((c) =>
    c.url.searchParams.has("page[after]") ? json(cursor("tickets", [{ ...ticket, id: 2 }])) : json(cursor("tickets", [ticket], `https://acme.zendesk.com/api/v2/tickets?page%5Bsize%5D=30&page%5Bafter%5D=AFTER&sort_by=updated_at`)),
  )
  const ids: number[] = []
  for await (const t of kit.paginate(conn, "tickets.list", { sort_by: "updated_at" })) ids.push(t.id)
  assert.deepEqual(ids, [35436, 2])
  assert.equal(calls[0]!.url.searchParams.get("page[size]"), "30")
  assert.equal(calls[0]!.url.searchParams.get("sort_by"), "updated_at")
  assert.equal(calls.length, 2, "the stale links.next on the last page must not trigger a third request")
})

test("page[size] is capped at Zendesk's 100", async () => {
  const { conn, calls } = h(() => json(cursor("tickets", [])))
  await conn.execute("tickets.list", { pageSize: 5000 })
  assert.equal(calls[0]!.url.searchParams.get("page[size]"), "100")
})

test("search uses per_page and follows next_page (offset style); null next_page ends it", async () => {
  const { conn, calls } = h((c) => json({ results: [{ id: c.url.searchParams.has("page") ? 2 : 1, result_type: "ticket", subject: "x" }], count: 2, next_page: c.url.searchParams.has("page") ? null : "https://acme.zendesk.com/api/v2/search?query=type%3Aticket&per_page=30&page=2" }))
  const first = await conn.execute("search", { query: "type:ticket" })
  assert.equal(calls[0]!.url.searchParams.get("query"), "type:ticket")
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "30")
  const second = await conn.execute("search", { query: "type:ticket", cursor: first.nextCursor! })
  assert.equal(second.nextCursor, null)
  assert.equal(second.items[0]!.id, 2)
})

test("search results of different kinds (ticket, user) share one schema", async () => {
  const { conn } = h(() => json({ results: [{ id: 1, result_type: "ticket", subject: "x", status: "open" }, { id: 2, result_type: "user", name: "Ada" }], next_page: null }))
  const page = await conn.execute("search", { query: "ada" })
  assert.deepEqual(page.items.map((r) => r.result_type), ["ticket", "user"])
})

test("tickets.create nests the fields as { ticket: { comment: { body } } } and is never retried", async () => {
  const { conn, calls } = h(() => json({ ticket }, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("tickets.create", { subject: "Printer", comment: "It is on fire", priority: "urgent", requester_email: "bo@x.dev", requester_name: "Bo", tags: ["fire"] })
  assert.equal(calls[0]!.init.method, "POST")
  assert.deepEqual(calls[0]!.body, { ticket: { subject: "Printer", comment: { body: "It is on fire" }, priority: "urgent", tags: ["fire"], requester: { email: "bo@x.dev", name: "Bo" } } })
})

test("a comment added with tickets.update is an INTERNAL NOTE unless public is explicitly true", async () => {
  const { conn, calls } = h(() => json({ ticket }))
  await conn.execute("tickets.update", { ticket_id: 7, comment: "checking with the vendor" })
  await conn.execute("tickets.update", { ticket_id: 7, comment: "We have fixed it.", public: true })
  assert.deepEqual((calls[0]!.body as { ticket: { comment: unknown } }).ticket.comment, { body: "checking with the vendor", public: false })
  assert.deepEqual((calls[1]!.body as { ticket: { comment: unknown } }).ticket.comment, { body: "We have fixed it.", public: true })
  assert.match(zendesk.actions["tickets.update"].description, /EMAILED TO THE CUSTOMER/)
})

test("tickets.update without a comment sends no comment at all, and the id is only in the path", async () => {
  const { conn, calls } = h(() => json({ ticket }))
  await conn.execute("tickets.update", { ticket_id: 7, status: "solved", assignee_id: 3 })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.equal(calls[0]!.url.pathname, "/api/v2/tickets/7")
  assert.deepEqual(calls[0]!.body, { ticket: { status: "solved", assignee_id: 3 } })
})

test("tickets.update is NOT retried after a 5xx: repeating it could add the same comment twice", async () => {
  const { conn, calls } = h(() => json({}, 503), { retry: { maxRetries: 3, sleep: async () => {}, random: () => 0 } })
  await assert.rejects(() => conn.execute("tickets.update", { ticket_id: 7, comment: "hi", public: true }))
  assert.equal(calls.length, 1)
})

test("the credential never appears in an error", async () => {
  const { conn } = h(() => json({ error: "Couldn't authenticate you" }, 401))
  await assert.rejects(() => conn.execute("users.me", {}), (e: unknown) => !JSON.stringify(e).includes("APITOKEN") && !(e as Error).message.includes("APITOKEN") && !JSON.stringify(e).includes(Buffer.from("me@acme.dev/token:APITOKEN").toString("base64")))
})
