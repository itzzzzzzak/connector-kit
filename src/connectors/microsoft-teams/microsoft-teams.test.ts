import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import teams from "./index.js"

const msg = { id: "1699999999999", createdDateTime: "2026-10-12T09:00:00Z", messageType: "message", from: { user: { id: "u1", displayName: "Ada" } }, body: { contentType: "text", content: "Hello team" } }

standardTests(teams, { action: "teams.list", input: {}, ok: { value: [{ id: "t1", displayName: "Engineering" }] }, badInput: { pageSize: "x" } })
standardTests(teams, { action: "channels.list", input: { teamId: "t1" }, ok: { value: [{ id: "19:abc@thread.tacv2", displayName: "General" }] }, badInput: { teamId: "" } })
standardTests(teams, { action: "channelMessages.list", input: { teamId: "t1", channelId: "c1" }, ok: { value: [msg] }, badInput: { teamId: "t1", channelId: "c1", pageSize: 500 } })
standardTests(teams, { action: "channelMessages.send", input: { teamId: "t1", channelId: "c1", content: "Hi" }, ok: msg, badInput: { teamId: "t1", channelId: "c1", content: "" } })
standardTests(teams, { action: "chats.list", input: {}, ok: { value: [{ id: "19:x@unq.gbl.spaces", chatType: "oneOnOne" }] }, badInput: { pageSize: "x" } })
standardTests(teams, { action: "chatMessages.list", input: { chatId: "19:x@unq.gbl.spaces" }, ok: { value: [msg] }, badInput: { chatId: "" } })
standardTests(teams, { action: "chatMessages.send", input: { chatId: "19:x@unq.gbl.spaces", content: "Hi" }, ok: msg, badInput: { chatId: "19:x", content: "" } })

test("channel ids with : and @ are encoded in the path and paging uses $top", async () => {
  const { conn, calls } = harness(teams, () => json({ value: [] }))
  await conn.execute("channelMessages.list", { teamId: "t1", channelId: "19:abc@thread.tacv2", pageSize: 10 })
  assert.equal(calls[0]!.url.pathname, "/v1.0/teams/t1/channels/19%3Aabc%40thread.tacv2/messages")
  assert.equal(calls[0]!.url.searchParams.get("$top"), "10")
})

test("posting wraps the text as a body object, text by default, and is a write", async () => {
  const { conn, calls } = harness(teams, () => json(msg, 201))
  await conn.execute("channelMessages.send", { teamId: "t1", channelId: "c1", content: "Hello" })
  assert.deepEqual(calls[0]!.body, { body: { contentType: "text", content: "Hello" } })
  await conn.execute("chatMessages.send", { chatId: "19:x", content: "<b>Hi</b>", contentType: "html" })
  assert.equal(calls[1]!.url.pathname, "/v1.0/chats/19%3Ax/messages")
  assert.deepEqual(calls[1]!.body, { body: { contentType: "html", content: "<b>Hi</b>" } })
  assert.equal(teams.actions["channelMessages.send"].effect, "write")
  assert.equal(teams.actions["chatMessages.send"].effect, "write")
})

test("a next link on another host is not followed", async () => {
  const { conn, calls } = harness(teams, () => json({ value: [msg], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=1" }))
  const page = (await conn.execute("chats.list", {})) as { nextCursor: string | null }
  assert.ok(page.nextCursor)
  await assert.rejects(() => conn.execute("chats.list", { cursor: "https://evil.example/x" }))
  assert.equal(calls.length, 1)
})
