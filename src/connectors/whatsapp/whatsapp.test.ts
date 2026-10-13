import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import { ConnectorKitError } from "../../index.js"
import whatsapp from "./index.js"

const isCode = (code: string) => (e: unknown) => e instanceof ConnectorKitError && e.code === code

const waba = "102290129340398"
const phone = "106540352242922"
const to = "15551234567"
const sent = { messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: "wamid.HBgL" }] }
const number = { id: phone, display_phone_number: "+1 555-025-3483", verified_name: "Acme", quality_rating: "GREEN" }

standardTests(whatsapp, { action: "phoneNumbers.list", input: { wabaId: waba }, ok: { data: [number], paging: { cursors: { before: "a", after: "b" } } }, badInput: { wabaId: "abc" } })
standardTests(whatsapp, { action: "phoneNumber.get", input: { phoneNumberId: phone }, ok: number, badInput: { phoneNumberId: "+15550253483" } })
standardTests(whatsapp, { action: "businessProfile.get", input: { phoneNumberId: phone }, ok: { data: [{ about: "Hi", websites: ["https://acme.dev"] }] }, badInput: { phoneNumberId: "" } })
standardTests(whatsapp, { action: "templates.list", input: { wabaId: waba }, ok: { data: [{ id: "1", name: "order_update", language: "en_US", status: "APPROVED", category: "UTILITY" }] }, badInput: { wabaId: waba, status: "GONE" } })
standardTests(whatsapp, { action: "media.get", input: { mediaId: "1234567890" }, ok: { id: "1234567890", url: "https://lookaside.example/x", mime_type: "image/jpeg", file_size: 100 }, badInput: { mediaId: "x" } })
standardTests(whatsapp, { action: "messages.sendText", input: { phoneNumberId: phone, to, text: "Hello" }, ok: sent, badInput: { phoneNumberId: phone, to: "+1 (555) 123-4567", text: "Hello" } })
standardTests(whatsapp, { action: "messages.sendTemplate", input: { phoneNumberId: phone, to, name: "order_update", language: "en_US" }, ok: sent, badInput: { phoneNumberId: phone, to, name: "", language: "en_US" } })
standardTests(whatsapp, { action: "messages.sendMedia", input: { phoneNumberId: phone, to, kind: "image", link: "https://example.com/a.jpg" }, ok: sent, badInput: { phoneNumberId: phone, to, kind: "image", link: "http://example.com/a.jpg" } })
standardTests(whatsapp, { action: "messages.markRead", input: { phoneNumberId: phone, messageId: "wamid.HBgL" }, ok: { success: true }, badInput: { phoneNumberId: phone, messageId: "" } })

test("a text send names the phone number in the path and sends Meta's body shape", async () => {
  const { conn, calls } = harness(whatsapp, () => json(sent))
  await conn.execute("messages.sendText", { phoneNumberId: phone, to, text: "Hello", previewUrl: true, replyToMessageId: "wamid.X" })
  assert.equal(calls[0]!.url.pathname, `/v23.0/${phone}/messages`)
  assert.deepEqual(calls[0]!.body, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: "Hello", preview_url: true }, context: { message_id: "wamid.X" } })
})

test("a template send carries the language code and components", async () => {
  const { conn, calls } = harness(whatsapp, () => json(sent))
  const components = [{ type: "body", parameters: [{ type: "text", text: "42" }] }]
  await conn.execute("messages.sendTemplate", { phoneNumberId: phone, to, name: "order_update", language: "en_US", components })
  assert.deepEqual(calls[0]!.body, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name: "order_update", language: { code: "en_US" }, components } })
})

test("a media send puts the link under the kind's own key", async () => {
  const { conn, calls } = harness(whatsapp, () => json(sent))
  await conn.execute("messages.sendMedia", { phoneNumberId: phone, to, kind: "document", link: "https://example.com/a.pdf", filename: "a.pdf", caption: "Invoice" })
  assert.deepEqual(calls[0]!.body, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "document", document: { link: "https://example.com/a.pdf", caption: "Invoice", filename: "a.pdf" } })
})

test("marking read sends status read, not a message", async () => {
  const { conn, calls } = harness(whatsapp, () => json({ success: true }))
  await conn.execute("messages.markRead", { phoneNumberId: phone, messageId: "wamid.X" })
  assert.deepEqual(calls[0]!.body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.X" })
})

test("Meta's code 190 on an HTTP 400 is auth_expired, and a rate-limit code on a 400 is rate_limited", async () => {
  const bad = harness(whatsapp, () => json({ error: { code: 190, type: "OAuthException", message: "Error validating access token" } }, 400))
  await assert.rejects(() => bad.conn.execute("phoneNumber.get", { phoneNumberId: phone }), isCode("auth_expired"))
  const slow = harness(whatsapp, () => json({ error: { code: 130429, message: "Rate limit hit" } }, 400))
  await assert.rejects(() => slow.conn.execute("phoneNumber.get", { phoneNumberId: phone }), (e: unknown) => isCode("rate_limited")(e) && (e as ConnectorKitError).retryable)
})

test("a list follows paging.next and stops when there is none", async () => {
  const next = `https://graph.facebook.com/v23.0/${waba}/phone_numbers?limit=1&after=XYZ`
  const more = harness(whatsapp, () => json({ data: [number], paging: { cursors: { after: "XYZ" }, next } }))
  const page = (await more.conn.execute("phoneNumbers.list", { wabaId: waba, pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(page.nextCursor, next)
  const last = harness(whatsapp, () => json({ data: [number], paging: { cursors: { after: "XYZ" } } }))
  assert.equal(((await last.conn.execute("phoneNumbers.list", { wabaId: waba })) as { nextCursor: string | null }).nextCursor, null)
})

test("sending actions are writes", () => {
  for (const name of ["messages.sendText", "messages.sendTemplate", "messages.sendMedia", "messages.markRead"] as const) assert.equal(whatsapp.actions[name].effect, "write")
})
