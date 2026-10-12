import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import sendgrid from "./index.js"

const tpl = { id: "d-123", name: "Welcome", generation: "dynamic", versions: [{ id: "v1", name: "v1", active: 1, subject: "Welcome" }] }
const send = { from: "hi@acme.dev", to: ["bob@acme.dev"], subject: "Hello", text: "Hi Bob" }

standardTests(sendgrid, { action: "mail.send", input: send, ok: {}, badInput: { from: "hi@acme.dev", to: ["bob@acme.dev"], subject: "No body" } })
standardTests(sendgrid, { action: "templates.list", input: {}, ok: { result: [tpl], _metadata: { count: 1 } }, badInput: { pageSize: 1000 } })
standardTests(sendgrid, { action: "template.get", input: { templateId: "d-123" }, ok: tpl, badInput: { templateId: "" } })
standardTests(sendgrid, { action: "bounces.list", input: {}, ok: [{ email: "gone@acme.dev", created: 1760000000, reason: "550 no such user", status: "5.1.1" }], badInput: { limit: 0 } })
standardTests(sendgrid, { action: "stats.get", input: { startDate: "2026-10-01" }, ok: [{ date: "2026-10-01", stats: [{ metrics: { requests: 10, delivered: 9 } }] }], badInput: { startDate: "yesterday" } })
standardTests(sendgrid, { action: "user.profile", input: {}, ok: { first_name: "Ada", last_name: "L", company: "Acme" } })

test("sending builds personalizations and lists text/plain before text/html", async () => {
  const { conn, calls } = harness(sendgrid, () => new Response(null, { status: 202 }))
  await conn.execute("mail.send", { ...send, fromName: "Acme", cc: ["eve@acme.dev"], html: "<p>Hi</p>", replyTo: "help@acme.dev", categories: ["welcome"] })
  assert.equal(calls[0]!.url.pathname, "/v3/mail/send")
  assert.deepEqual(calls[0]!.body, {
    personalizations: [{ to: [{ email: "bob@acme.dev" }], cc: [{ email: "eve@acme.dev" }] }],
    from: { email: "hi@acme.dev", name: "Acme" },
    subject: "Hello",
    content: [{ type: "text/plain", value: "Hi Bob" }, { type: "text/html", value: "<p>Hi</p>" }],
    reply_to: { email: "help@acme.dev" },
    categories: ["welcome"],
  })
})

test("an html-only message has just the html part, and a send is never retried after a 5xx", async () => {
  const { conn, calls } = harness(sendgrid, () => json({}, 503), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await assert.rejects(() => conn.execute("mail.send", { from: "hi@acme.dev", to: ["bob@acme.dev"], subject: "Hi", html: "<p>x</p>" }))
  assert.equal(calls.length, 1)
  assert.deepEqual((calls[0]!.body as { content: unknown }).content, [{ type: "text/html", value: "<p>x</p>" }])
  assert.equal(sendgrid.actions["mail.send"].effect, "write")
})

test("templates ask for dynamic ones, use page_size, and follow the full next link", async () => {
  const next = "https://api.sendgrid.com/v3/templates?generations=dynamic&page_size=1&page_token=abc"
  const { conn, calls } = harness(sendgrid, () => json({ result: [tpl], _metadata: { next } }))
  const page = (await conn.execute("templates.list", { pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("generations"), "dynamic")
  assert.equal(calls[0]!.url.searchParams.get("page_size"), "1")
  assert.equal(page.nextCursor, next)
  await conn.execute("templates.list", { cursor: next })
  assert.equal(calls[1]!.url.searchParams.get("page_token"), "abc")
  await assert.rejects(() => conn.execute("templates.list", { cursor: "https://evil.example/x" }))
  assert.equal(calls.length, 2)
})

test("bounces send a bounded page by default and rename the time filters", async () => {
  const { conn, calls } = harness(sendgrid, () => json([]))
  await conn.execute("bounces.list", {})
  assert.equal(calls[0]!.url.searchParams.get("limit"), "25")
  assert.equal(calls[0]!.url.searchParams.get("offset"), "0")
  await conn.execute("bounces.list", { startTime: 1760000000, endTime: 1760086400, email: "gone@acme.dev" })
  assert.equal(calls[1]!.url.searchParams.get("start_time"), "1760000000")
  assert.equal(calls[1]!.url.searchParams.get("end_time"), "1760086400")
  assert.equal(calls[1]!.url.searchParams.get("email"), "gone@acme.dev")
})
