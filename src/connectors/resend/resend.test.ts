import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import resend from "./index.js"

const email = { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794", from: "Acme <hi@acme.dev>", to: ["bob@acme.dev"], subject: "Hello", created_at: "2026-10-12T09:00:00.000Z", last_event: "delivered" }
const send = { from: "Acme <hi@acme.dev>", to: "bob@acme.dev", subject: "Hello", text: "Hi Bob" }

standardTests(resend, { action: "emails.send", input: send, ok: { id: email.id }, badInput: { from: "hi@acme.dev", to: "bob@acme.dev", subject: "No body" } })
standardTests(resend, { action: "email.get", input: { emailId: email.id }, ok: email, badInput: { emailId: "" } })
standardTests(resend, { action: "emails.list", input: {}, ok: { object: "list", data: [email], has_more: false }, badInput: { pageSize: 1000 } })
standardTests(resend, { action: "email.cancel", input: { emailId: email.id }, ok: { object: "email", id: email.id }, badInput: { emailId: "" } })
standardTests(resend, { action: "domains.list", input: {}, ok: { object: "list", data: [{ id: "d1", name: "acme.dev", status: "verified" }], has_more: false }, badInput: { pageSize: "x" } })
standardTests(resend, { action: "domain.get", input: { domainId: "d1" }, ok: { id: "d1", name: "acme.dev", status: "pending", records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1 ...", status: "not_started" }] }, badInput: { domainId: "" } })

test("sending maps camelCase fields to Resend's names and sends the rest unchanged", async () => {
  const { conn, calls } = harness(resend, () => json({ id: email.id }))
  await conn.execute("emails.send", { ...send, to: ["bob@acme.dev", "eve@acme.dev"], replyTo: "support@acme.dev", scheduledAt: "in 1 hour", html: "<p>Hi</p>" })
  assert.equal(calls[0]!.url.pathname, "/emails")
  assert.deepEqual(calls[0]!.body, { from: send.from, to: ["bob@acme.dev", "eve@acme.dev"], subject: "Hello", text: "Hi Bob", html: "<p>Hi</p>", reply_to: "support@acme.dev", scheduled_at: "in 1 hour" })
})

test("a send carries an idempotency key that is reused when it is retried after a 5xx", async () => {
  let n = 0
  const { conn, calls } = harness(resend, () => (++n === 1 ? json({}, 503) : json({ id: email.id })), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("emails.send", send)
  assert.equal(calls.length, 2)
  const key = calls[0]!.header("Idempotency-Key")
  assert.ok(key && key.length >= 16)
  assert.equal(calls[1]!.header("Idempotency-Key"), key)
})

test("a list pages by the last id with has_more, and stops when there is no more", async () => {
  const { conn, calls } = harness(resend, () => json({ object: "list", data: [email, { ...email, id: "second" }], has_more: true }))
  const page = (await conn.execute("emails.list", { pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("limit"), "2")
  assert.equal(page.nextCursor, "second")
  await conn.execute("emails.list", { cursor: "second" })
  assert.equal(calls[1]!.url.searchParams.get("after"), "second")
  const last = harness(resend, () => json({ object: "list", data: [email], has_more: false }))
  assert.equal(((await last.conn.execute("emails.list", {})) as { nextCursor: string | null }).nextCursor, null)
})

test("sending is a write and cancelling is destructive", () => {
  assert.equal(resend.actions["emails.send"].effect, "write")
  assert.equal(resend.actions["email.cancel"].effect, "destructive")
})
