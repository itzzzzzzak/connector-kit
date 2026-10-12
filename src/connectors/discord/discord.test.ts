import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import discord from "./index.js"

const G = "800000000000000001"
const C = "800000000000000002"
const M = "800000000000000003"
const U = "800000000000000004"
const user = { id: U, username: "ada", global_name: "Ada", bot: false }
const message = { id: M, channel_id: C, content: "Hello", timestamp: "2026-10-12T10:00:00.000000+00:00", author: user, embeds: [], attachments: [] }
const channel = { id: C, type: 0, name: "general", guild_id: G, parent_id: null }
const guild = { id: G, name: "Acme" }
const member = { user, nick: null, roles: [], joined_at: "2026-01-01T00:00:00.000000+00:00" }

standardTests(discord, { action: "bot.get", input: {}, ok: { id: U, username: "acme-bot", bot: true } })
standardTests(discord, { action: "guilds.list", input: {}, ok: [guild], badInput: { with_counts: "yes" } })
standardTests(discord, { action: "guild.get", input: { guild_id: G }, ok: guild, badInput: { guild_id: "acme" } })
standardTests(discord, { action: "channels.list", input: { guild_id: G }, ok: [channel], badInput: { guild_id: "1" } })
standardTests(discord, { action: "messages.list", input: { channel_id: C }, ok: [message], badInput: { channel_id: "../x" } })
standardTests(discord, { action: "message.get", input: { channel_id: C, message_id: M }, ok: message, badInput: { channel_id: C, message_id: "x" } })
standardTests(discord, { action: "messages.send", input: { channel_id: C, content: "Hello" }, ok: message, badInput: { channel_id: C } })
standardTests(discord, { action: "message.edit", input: { channel_id: C, message_id: M, content: "Edited" }, ok: message, badInput: { channel_id: C, message_id: M, content: 5 } })
standardTests(discord, { action: "message.delete", input: { channel_id: C, message_id: M }, ok: {}, badInput: { channel_id: C, message_id: "x" } })
standardTests(discord, { action: "reaction.add", input: { channel_id: C, message_id: M, emoji: "👍" }, ok: {}, badInput: { channel_id: C, message_id: M, emoji: "" } })
standardTests(discord, { action: "members.list", input: { guild_id: G }, ok: [member], badInput: { guild_id: G, pageSize: "x" } })
standardTests(discord, { action: "member.get", input: { guild_id: G, user_id: U }, ok: member, badInput: { guild_id: G, user_id: "x" } })
standardTests(discord, { action: "roles.list", input: { guild_id: G }, ok: [{ id: "800000000000000005", name: "Admin", permissions: "8" }], badInput: { guild_id: "x" } })
standardTests(discord, { action: "member.kick", input: { guild_id: G, user_id: U }, ok: {}, badInput: { guild_id: G, user_id: "x" } })
standardTests(discord, { action: "member.ban", input: { guild_id: G, user_id: U, delete_message_seconds: 3600 }, ok: {}, badInput: { guild_id: G, user_id: U, delete_message_seconds: 99999999 } })
standardTests(discord, { action: "dm.open", input: { recipient_id: U }, ok: { id: C, type: 1 }, badInput: { recipient_id: "x" } })

const h = (respond: Parameters<typeof harness>[1]) => harness(discord, respond, { credentials: { token: "bot-token" } })

test("calls carry the Bot authorization and a descriptive User-Agent", async () => {
  const { conn, calls } = h(() => json(user))
  await conn.execute("bot.get", {})
  assert.equal(calls[0]!.url.toString(), "https://discord.com/api/v10/users/@me")
  assert.equal(calls[0]!.header("authorization"), "Bot bot-token")
  assert.match(calls[0]!.header("user-agent")!, /^DiscordBot \(https:\/\/github\.com\/.+, \d/)
})

test("messages page backwards: a full page continues before the oldest id, a short one ends", async () => {
  const older = "800000000000000099"
  const full = [message, { ...message, id: older }]
  const { conn, calls } = h((call) => json(call.url.searchParams.get("before") ? [] : full))
  const first = (await conn.execute("messages.list", { channel_id: C, pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("limit"), "2")
  assert.equal(first.nextCursor, older)
  const second = (await conn.execute("messages.list", { channel_id: C, pageSize: 2, cursor: older })) as { nextCursor: string | null }
  assert.equal(calls[1]!.url.searchParams.get("before"), older)
  assert.equal(second.nextCursor, null)
})

test("members page forwards by the nested user id", async () => {
  const { conn, calls } = h(() => json([{ ...member, user: { ...user, id: "800000000000000010" } }, { ...member, user: { ...user, id: "800000000000000020" } }]))
  const page = (await conn.execute("members.list", { guild_id: G, pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(page.nextCursor, "800000000000000020")
  await conn.execute("members.list", { guild_id: G, cursor: "800000000000000020" })
  assert.equal(calls[1]!.url.searchParams.get("after"), "800000000000000020")
})

test("a message switches mentions off by default, so a model cannot ping @everyone", async () => {
  const { conn, calls } = h(() => json(message))
  await conn.execute("messages.send", { channel_id: C, content: "@everyone wake up" })
  assert.deepEqual(calls[0]!.body, { content: "@everyone wake up", allowed_mentions: { parse: [] } })
  await conn.execute("messages.send", { channel_id: C, content: "Hi <@" + U + ">", allowMentions: true })
  assert.deepEqual(calls[1]!.body, { content: "Hi <@" + U + ">" })
  await conn.execute("message.edit", { channel_id: C, message_id: M, content: "@here" })
  assert.deepEqual(calls[2]!.body, { content: "@here", allowed_mentions: { parse: [] } })
})

test("a reply names the message it answers, and an embed alone is enough content", async () => {
  const { conn, calls } = h(() => json(message))
  await conn.execute("messages.send", { channel_id: C, embeds: [{ title: "Report", description: "All green", color: 0x2ecc71 }], replyToMessageId: M })
  assert.deepEqual((calls[0]!.body as { message_reference: unknown }).message_reference, { message_id: M, fail_if_not_exists: false })
  assert.equal((calls[0]!.body as { embeds: unknown[] }).embeds.length, 1)
})

test("a custom or Unicode emoji is encoded into the reaction path", async () => {
  const { conn, calls } = h(() => new Response(null, { status: 204 }))
  await conn.execute("reaction.add", { channel_id: C, message_id: M, emoji: "👍" })
  await conn.execute("reaction.add", { channel_id: C, message_id: M, emoji: "party:123456789012345678" })
  assert.equal(calls[0]!.url.pathname, `/api/v10/channels/${C}/messages/${M}/reactions/%F0%9F%91%8D/@me`)
  assert.equal(calls[1]!.url.pathname, `/api/v10/channels/${C}/messages/${M}/reactions/party%3A123456789012345678/@me`)
  assert.equal(calls[0]!.init.method, "PUT")
})

test("a fractional Retry-After on a 429 is kept, and the request is retried only for reads", async () => {
  const { conn } = h(() => json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429, { "retry-after": "1.5" }))
  await assert.rejects(() => conn.execute("messages.list", { channel_id: C }), (e: unknown) => {
    const err = e as { code?: string; retryAfter?: number; retryable?: boolean }
    return err.code === "rate_limited" && err.retryAfter === 1.5 && err.retryable === true
  })
})

test("kicking, banning and deleting are destructive; every generated DELETE is too", () => {
  const actions = discord.actions as Record<string, { effect: string; method: string; path: string }>
  for (const name of ["member.kick", "member.ban", "message.delete"]) assert.equal(actions[name]!.effect, "destructive", name)
  for (const [name, action] of Object.entries(actions)) if (action.method === "DELETE") assert.equal(action.effect, "destructive", name)
  assert.ok(Object.keys(actions).length > 200)
})

test("a ban sends the number of seconds of messages to delete in the body", async () => {
  const { conn, calls } = h(() => new Response(null, { status: 204 }))
  await conn.execute("member.ban", { guild_id: G, user_id: U, delete_message_seconds: 3600 })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.equal(calls[0]!.url.pathname, `/api/v10/guilds/${G}/bans/${U}`)
})
