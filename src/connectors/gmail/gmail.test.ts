import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import gmail from "./index.js"
import { buildRawMessage } from "./mime.js"

const message = { id: "18f", threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "Hi", internalDate: "1760000000000", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Hello" }], body: { size: 2, data: "SGk" } } }
const draft = { id: "r1", message: { id: "18f", threadId: "t1" } }

standardTests(gmail, { action: "profile.get", input: {}, ok: { emailAddress: "ada@acme.dev", messagesTotal: 10 } })
standardTests(gmail, { action: "messages.list", input: { q: "is:unread" }, ok: { messages: [{ id: "18f", threadId: "t1" }], nextPageToken: "p2" }, badInput: { pageSize: "ten" } })
standardTests(gmail, { action: "messages.get", input: { id: "18f", format: "metadata" }, ok: message, badInput: { id: "" } })
standardTests(gmail, { action: "messages.send", input: { to: ["bob@acme.dev"], subject: "Hi", body: "Hello" }, ok: message, badInput: { to: [], subject: "Hi", body: "x" } })
standardTests(gmail, { action: "messages.modify", input: { id: "18f", removeLabelIds: ["UNREAD"] }, ok: message, badInput: { id: "18f", addLabelIds: "STARRED" } })
standardTests(gmail, { action: "threads.list", input: { q: "from:ada" }, ok: { threads: [{ id: "t1", snippet: "Hi" }] }, badInput: { labelIds: "INBOX" } })
standardTests(gmail, { action: "threads.get", input: { id: "t1" }, ok: { id: "t1", messages: [message] }, badInput: { id: "" } })
standardTests(gmail, { action: "labels.list", input: {}, ok: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] } })
standardTests(gmail, { action: "drafts.create", input: { to: ["bob@acme.dev"], subject: "Hi", body: "Draft" }, ok: draft, badInput: { to: ["bob@acme.dev"], subject: "Hi\r\nBcc: x@evil.dev", body: "x" } })
standardTests(gmail, { action: "drafts.list", input: {}, ok: { drafts: [draft] }, badInput: { pageSize: "x" } })

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8")
const bodyOf = (mail: string) => Buffer.from(mail.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8")

test("every call goes to the signed-in user's mailbox by default, with the bearer token", async () => {
  const { conn, calls } = harness(gmail, () => json({ labels: [] }))
  await conn.execute("labels.list", {})
  assert.equal(calls[0]!.url.toString(), "https://gmail.googleapis.com/gmail/v1/users/me/labels")
  assert.equal(calls[0]!.header("authorization"), "Bearer test-token")
})

test("a search is paged with maxResults and pageToken, and the next page token is the cursor", async () => {
  const { conn, calls } = harness(gmail, (call) => json(call.url.searchParams.get("pageToken") ? { messages: [{ id: "b" }] } : { messages: [{ id: "a" }], nextPageToken: "p2" }))
  const first = (await conn.execute("messages.list", { q: "is:unread", pageSize: 10 })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("maxResults"), "10")
  assert.equal(calls[0]!.url.searchParams.get("q"), "is:unread")
  assert.equal(first.nextCursor, "p2")
  const second = (await conn.execute("messages.list", { cursor: "p2" })) as { nextCursor: string | null }
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "p2")
  assert.equal(second.nextCursor, null)
})

test("send builds a UTF-8 base64url message from plain fields", async () => {
  const { conn, calls } = harness(gmail, () => json(message))
  await conn.execute("messages.send", { to: ["bob@acme.dev", "Cy <cy@acme.dev>"], cc: ["di@acme.dev"], subject: "Grüße ✓", body: "Zażółć gęślą jaźń", threadId: "t9", inReplyTo: "<abc@mail.acme.dev>" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/messages/send")
  const sent = calls[0]!.body as { raw: string; threadId: string }
  assert.equal(sent.threadId, "t9")
  assert.match(sent.raw, /^[A-Za-z0-9_-]+$/)
  const mail = decode(sent.raw)
  assert.match(mail, /^MIME-Version: 1\.0\r\nTo: bob@acme\.dev, Cy <cy@acme\.dev>\r\nCc: di@acme\.dev\r\nSubject: =\?UTF-8\?B\?/)
  assert.match(mail, /In-Reply-To: <abc@mail\.acme\.dev>\r\nReferences: <abc@mail\.acme\.dev>/)
  assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mail)![1]!, "base64").toString("utf8"), "Grüße ✓")
  assert.equal(bodyOf(mail), "Zażółć gęślą jaźń")
})

test("send marks HTML bodies, and an ASCII subject stays readable", () => {
  const mail = decode(buildRawMessage({ to: ["a@b.dev"], subject: "Plain subject", body: "<p>Hi</p>", html: true }))
  assert.match(mail, /Subject: Plain subject\r\n/)
  assert.match(mail, /Content-Type: text\/html; charset="UTF-8"/)
})

test("a line break in any header is refused before anything is sent", async () => {
  const { conn, calls } = harness(gmail, () => json(message))
  for (const input of [
    { to: ["a@b.dev\r\nBcc: spy@evil.dev"], subject: "x", body: "x" },
    { to: ["a@b.dev"], subject: "x\nBcc: spy@evil.dev", body: "x" },
    { to: ["a@b.dev"], bcc: ["c@d.dev\r\nX: y"], subject: "x", body: "x" },
    { to: ["a@b.dev"], subject: "x", body: "x", inReplyTo: "<a>\r\nBcc: z@evil.dev" },
  ]) {
    await assert.rejects(() => conn.execute("messages.send", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(calls.length, 0)
  assert.throws(() => buildRawMessage({ to: ["a@b.dev\nBcc: x"], subject: "x", body: "x" }))
})

test("a draft wraps the message, and modify sends only the label changes", async () => {
  const { conn, calls } = harness(gmail, () => json(draft))
  await conn.execute("drafts.create", { to: ["bob@acme.dev"], subject: "Hi", body: "Draft" })
  assert.deepEqual(Object.keys(calls[0]!.body as object), ["message"])
  assert.ok(typeof (calls[0]!.body as { message: { raw: string } }).message.raw === "string")
  const mod = harness(gmail, () => json(message))
  await mod.conn.execute("messages.modify", { id: "18f", addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] })
  assert.deepEqual(mod.calls[0]!.body, { addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] })
})

test("sending is a write, and trashing or deleting a message is destructive", () => {
  const actions = gmail.actions as Record<string, { effect: string }>
  assert.equal(actions["messages.send"]!.effect, "write")
  assert.equal(actions["messages.trash"]!.effect, "destructive")
  assert.equal(actions["messages.delete"]!.effect, "destructive")
})

test("a message keeps its nested parts and base64url body data", async () => {
  const nested = { ...message, payload: { mimeType: "multipart/alternative", parts: [{ partId: "0", mimeType: "text/plain", body: { size: 2, data: "SGk" } }] } }
  const { conn } = harness(gmail, () => json(nested))
  const got = (await conn.execute("messages.get", { id: "18f", format: "full" })) as { payload: { parts: Array<{ body: { data: string } }> } }
  assert.equal(got.payload.parts[0]!.body.data, "SGk")
})
