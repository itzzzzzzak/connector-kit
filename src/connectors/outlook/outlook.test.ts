import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import outlook from "./index.js"

const msg = { id: "AAMk1", subject: "Budget", bodyPreview: "Numbers attached", from: { emailAddress: { name: "Ada", address: "ada@acme.dev" } }, receivedDateTime: "2026-10-12T09:00:00Z", isRead: false }
const ev = { id: "AAEv1", subject: "Standup", start: { dateTime: "2026-10-14T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-14T09:15:00.0000000", timeZone: "UTC" } }
const when = { dateTime: "2026-10-14T09:00:00", timeZone: "UTC" }
const mail = { subject: "Hello", body: "Hi Bob", to: ["bob@acme.dev"] }

standardTests(outlook, { action: "me.get", input: {}, ok: { id: "u1", displayName: "Ada", mail: "ada@acme.dev" } })
standardTests(outlook, { action: "mailFolders.list", input: {}, ok: { value: [{ id: "f1", displayName: "Inbox", unreadItemCount: 3 }] }, badInput: { pageSize: 0 } })
standardTests(outlook, { action: "messages.list", input: {}, ok: { value: [msg] }, badInput: { search: "a", filter: "isRead eq false" } })
standardTests(outlook, { action: "message.get", input: { messageId: "AAMk1" }, ok: { ...msg, body: { contentType: "html", content: "<p>Hi</p>" } }, badInput: { messageId: "" } })
standardTests(outlook, { action: "drafts.create", input: mail, ok: { ...msg, isDraft: true }, badInput: { ...mail, to: ["not-an-email"] } })
standardTests(outlook, { action: "messages.send", input: mail, ok: {}, badInput: { ...mail, to: [] } })
standardTests(outlook, { action: "message.delete", input: { messageId: "AAMk1" }, ok: {}, badInput: { messageId: "" } })
standardTests(outlook, { action: "events.list", input: { startDateTime: "2026-10-14T00:00:00Z", endDateTime: "2026-10-15T00:00:00Z" }, ok: { value: [ev] }, badInput: { startDateTime: "2026-10-14T00:00:00Z" } })
standardTests(outlook, { action: "event.get", input: { eventId: "AAEv1" }, ok: ev, badInput: { eventId: "" } })
standardTests(outlook, { action: "events.create", input: { subject: "Standup", start: when, end: when }, ok: ev, badInput: { subject: "Standup", start: when } })
standardTests(outlook, { action: "event.delete", input: { eventId: "AAEv1" }, ok: {}, badInput: { eventId: "" } })
standardTests(outlook, { action: "schedule.get", input: { schedules: ["bob@acme.dev"], startTime: when, endTime: when }, ok: { value: [{ scheduleId: "bob@acme.dev", availabilityView: "0022" }] }, badInput: { schedules: [], startTime: when, endTime: when } })
standardTests(outlook, { action: "contacts.list", input: {}, ok: { value: [{ id: "c1", displayName: "Bob", emailAddresses: [{ address: "bob@acme.dev" }] }] }, badInput: { pageSize: "x" } })

test("messages go to the inbox by default, newest first, with $top, and a search is quoted", async () => {
  const { conn, calls } = harness(outlook, () => json({ value: [] }))
  await conn.execute("messages.list", { pageSize: 10 })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/mailFolders/inbox/messages")
  assert.equal(calls[0]!.url.searchParams.get("$top"), "10")
  assert.equal(calls[0]!.url.searchParams.get("$orderby"), "receivedDateTime desc")
  await conn.execute("messages.list", { folderId: "sentitems", search: 'from:ada "quoted"' })
  assert.equal(calls[1]!.url.pathname, "/v1.0/me/mailFolders/sentitems/messages")
  assert.equal(calls[1]!.url.searchParams.get("$search"), '"from:ada  quoted "')
  assert.equal(calls[1]!.url.searchParams.has("$orderby"), false)
  await conn.execute("messages.list", { filter: "isRead eq false" })
  assert.equal(calls[2]!.url.searchParams.get("$filter"), "isRead eq false")
  assert.equal(calls[2]!.url.searchParams.has("$orderby"), false)
})

test("paging follows @odata.nextLink and a link to another host is refused before anything is sent", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1&$skiptoken=abc"
  const { conn, calls } = harness(outlook, () => json({ value: [msg], "@odata.nextLink": next }))
  const page = (await conn.execute("messages.list", { pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(page.nextCursor, next)
  await conn.execute("messages.list", { cursor: next })
  assert.equal(calls[1]!.url.searchParams.get("$skiptoken"), "abc")
  await assert.rejects(() => conn.execute("messages.list", { cursor: "https://evil.example/steal" }), (e: unknown) => ["invalid_input", "invalid", "forbidden"].includes((e as { code?: string }).code ?? ""))
  assert.equal(calls.length, 2)
})

test("sending mail wraps the message, saves a sent copy and sends no extra fields", async () => {
  const { conn, calls } = harness(outlook, () => new Response(null, { status: 202 }))
  await conn.execute("messages.send", { subject: "Hello", body: "<b>Hi</b>", contentType: "html", to: ["bob@acme.dev"], cc: ["eve@acme.dev"] })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/sendMail")
  assert.deepEqual(calls[0]!.body, {
    message: { subject: "Hello", body: { contentType: "html", content: "<b>Hi</b>" }, toRecipients: [{ emailAddress: { address: "bob@acme.dev" } }], ccRecipients: [{ emailAddress: { address: "eve@acme.dev" } }] },
    saveToSentItems: true,
  })
})

test("a draft is saved, not sent: it posts to /me/messages with the message as the body", async () => {
  const { conn, calls } = harness(outlook, () => json({ ...msg, isDraft: true }))
  await conn.execute("drafts.create", { subject: "Hello", body: "Hi", to: ["bob@acme.dev"] })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/messages")
  assert.deepEqual(calls[0]!.body, { subject: "Hello", body: { contentType: "text", content: "Hi" }, toRecipients: [{ emailAddress: { address: "bob@acme.dev" } }] })
})

test("the calendar window is sent as startDateTime and endDateTime; creating an event shapes attendees", async () => {
  const { conn, calls } = harness(outlook, () => json({ value: [] }))
  await conn.execute("events.list", { startDateTime: "2026-10-14T00:00:00Z", endDateTime: "2026-10-15T00:00:00Z" })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/calendarView")
  assert.equal(calls[0]!.url.searchParams.get("startDateTime"), "2026-10-14T00:00:00Z")
  assert.equal(calls[0]!.url.searchParams.get("endDateTime"), "2026-10-15T00:00:00Z")
  const created = harness(outlook, () => json(ev))
  await created.conn.execute("events.create", { subject: "Standup", start: when, end: when, attendees: ["bob@acme.dev"], location: "Room 1", isOnlineMeeting: true })
  assert.deepEqual(created.calls[0]!.body, { subject: "Standup", start: when, end: when, location: { displayName: "Room 1" }, attendees: [{ emailAddress: { address: "bob@acme.dev" }, type: "required" }], isOnlineMeeting: true })
})

test("deleting is destructive and message ids with = and / are encoded in the path", async () => {
  assert.equal(outlook.actions["message.delete"].effect, "destructive")
  assert.equal(outlook.actions["event.delete"].effect, "destructive")
  assert.equal(outlook.actions["messages.send"].effect, "write")
  const { conn, calls } = harness(outlook, () => new Response(null, { status: 204 }))
  await conn.execute("message.delete", { messageId: "AAMk=/x" })
  assert.equal(calls[0]!.init.method, "DELETE")
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/messages/AAMk%3D%2Fx")
})
