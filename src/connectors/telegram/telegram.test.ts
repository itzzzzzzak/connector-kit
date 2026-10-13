import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import telegram from "./index.js"

const chat = { id: -1001234567890, type: "supergroup", title: "Team" }
const msg = { message_id: 42, date: 1760000000, chat, text: "hello" }
const ok = (result: unknown) => ({ ok: true, result })

standardTests(telegram, { action: "me.get", input: {}, ok: ok({ id: 1, is_bot: true, first_name: "Bot", username: "acme_bot" }) })
standardTests(telegram, { action: "updates.get", input: { offset: 5 }, ok: ok([{ update_id: 5, message: msg }]), badInput: { limit: 1000 } })
standardTests(telegram, { action: "chat.get", input: { chatId: chat.id }, ok: ok(chat), badInput: { chatId: "no-at-sign" } })
standardTests(telegram, { action: "messages.send", input: { chatId: chat.id, text: "hello" }, ok: ok(msg), badInput: { chatId: chat.id, text: "" } })
standardTests(telegram, { action: "photos.send", input: { chatId: "@acme", photo: "https://example.com/a.jpg" }, ok: ok(msg), badInput: { chatId: chat.id, photo: "" } })
standardTests(telegram, { action: "messages.edit", input: { chatId: chat.id, messageId: 42, text: "edited" }, ok: ok(msg), badInput: { chatId: chat.id, messageId: 0, text: "x" } })
standardTests(telegram, { action: "messages.forward", input: { chatId: chat.id, fromChatId: 7, messageId: 42 }, ok: ok(msg), badInput: { chatId: chat.id, fromChatId: 7, messageId: -1 } })
standardTests(telegram, { action: "messages.delete", input: { chatId: chat.id, messageId: 42 }, ok: ok(true), badInput: { chatId: chat.id, messageId: "42" } })
standardTests(telegram, { action: "chat.leave", input: { chatId: chat.id }, ok: ok(true), badInput: { chatId: 1.5 } })
standardTests(telegram, { action: "webhook.get", input: {}, ok: ok({ url: "", pending_update_count: 0 }) })
standardTests(telegram, { action: "webhook.set", input: { url: "https://example.com/hook" }, ok: ok(true), badInput: { url: "http://example.com/hook" } })
standardTests(telegram, { action: "webhook.delete", input: {}, ok: ok(true) })

const token = "123456789:AAH-secret_token"
const connect = { credentials: { token } }

test("the bot token goes in the URL path after /bot, and the method name follows it", async () => {
  const { conn, calls } = harness(telegram, () => json(ok(msg)), connect)
  await conn.execute("messages.send", { chatId: chat.id, text: "hello" })
  assert.equal(calls[0]!.url.pathname, `/bot${token}/sendMessage`)
  assert.equal(calls[0]!.header("authorization"), null)
})

test("a send maps camelCase options to Telegram's names and returns the message, not the envelope", async () => {
  const { conn, calls } = harness(telegram, () => json(ok(msg)), connect)
  const sent = await conn.execute("messages.send", { chatId: "@acme", text: "*hi*", parseMode: "MarkdownV2", disableNotification: true, replyToMessageId: 9 })
  assert.deepEqual(calls[0]!.body, { chat_id: "@acme", text: "*hi*", parse_mode: "MarkdownV2", disable_notification: true, reply_parameters: { message_id: 9 } })
  assert.equal((sent as { message_id: number }).message_id, 42)
})

test("updates.get never waits: it sends timeout 0 and the offset", async () => {
  const { conn, calls } = harness(telegram, () => json(ok([])), connect)
  assert.deepEqual(await conn.execute("updates.get", { offset: 11, limit: 50 }), [])
  assert.deepEqual(calls[0]!.body, { timeout: 0, offset: 11, limit: 50 })
})

test("a Telegram error body (ok: false) with a 400 is refused, not parsed as data", async () => {
  const { conn } = harness(telegram, () => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400), connect)
  await assert.rejects(() => conn.execute("chat.get", { chatId: 5 }), (e: unknown) => (e as { code: string }).code !== undefined)
})

test("sending is a write; deleting a message, leaving a chat and removing the webhook are destructive", () => {
  assert.equal(telegram.actions["messages.send"].effect, "write")
  for (const name of ["messages.delete", "chat.leave", "webhook.delete"] as const) assert.equal(telegram.actions[name].effect, "destructive")
})
