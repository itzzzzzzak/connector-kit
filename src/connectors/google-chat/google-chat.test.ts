import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import chat from "./index.js"

const space = { name: "spaces/AAA", displayName: "Team", spaceType: "SPACE" }
const message = { name: "spaces/AAA/messages/BBB", text: "Hi", createTime: "2026-10-12T10:00:00Z", sender: { name: "users/1", displayName: "Ada" } }

standardTests(chat, { action: "spaces.list", input: {}, ok: { spaces: [space], nextPageToken: "p2" }, badInput: { pageSize: "ten" } })
standardTests(chat, { action: "messages.list", input: { parent: "spaces/AAA" }, ok: { messages: [message] }, badInput: { parent: "AAA" } })
standardTests(chat, { action: "messages.create", input: { parent: "spaces/AAA", text: "Hi" }, ok: message, badInput: { parent: "spaces/AAA", text: "" } })

test("a space name keeps its slash in the path, and a message goes in the body", async () => {
  const { conn, calls } = harness(chat, () => json(message))
  await conn.execute("messages.create", { parent: "spaces/AAA", text: "Hello team" })
  assert.equal(calls[0]!.url.toString(), "https://chat.googleapis.com/v1/spaces/AAA/messages")
  assert.deepEqual(calls[0]!.body, { text: "Hello team" })
})

test("a reply names its thread and asks Chat to fall back to a new thread", async () => {
  const { conn, calls } = harness(chat, () => json(message))
  await conn.execute("messages.create", { parent: "spaces/AAA", text: "Re", threadName: "spaces/AAA/threads/T1" })
  assert.equal(calls[0]!.url.searchParams.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
  assert.deepEqual(calls[0]!.body, { text: "Re", thread: { name: "spaces/AAA/threads/T1" } })
})

test("a path-like value cannot climb out of the request path", async () => {
  const { conn, calls } = harness(chat, () => json({ messages: [] }))
  await assert.rejects(() => conn.execute("messages.list", { parent: "spaces/../admin" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})
