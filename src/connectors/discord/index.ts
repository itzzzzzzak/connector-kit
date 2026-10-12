import { defineConnector, lastIdPagination } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Discord's HTTP API reference (discord.com/developers/docs) and the OpenAPI description Discord publishes
// (github.com/discord/discord-api-spec, MIT, API v10): base URL https://discord.com/api/v10, a bot token sent as `Authorization: Bot <token>`,
// JSON bodies, ids are "snowflakes" (17 to 20 digit strings), and lists are plain arrays paged by the id of the last item, with `before`
// (newest first, channel messages) or `after` (oldest first, members, bans) and `limit` (up to 100, messages and members 1000 for members).
// Discord asks every client for a descriptive User-Agent ("DiscordBot (url, version)") and blocks requests without one. Rate limits are per
// route, answered with HTTP 429 and a `Retry-After` in seconds (it may be fractional); a bot that keeps hitting them is banned for an hour.
// A bot can only see the servers it was added to and the channels its role can view, and reading message text needs the Message Content
// privileged intent (otherwise `content` is empty except for messages that mention the bot).
//
// This connector acts as a BOT. Acting as a user with OAuth (identify, guilds) is a different token type that Discord sends as Bearer, and is
// not covered. File attachments (multipart uploads) and the gateway (real-time events, voice) are not covered either.
// A curated, typed set is written by hand; the rest of the HTTP API (about 230 calls) is generated from Discord's description (ADR-018) and
// untyped on the way out.
// SECURITY: messages, usernames, nicknames and embeds are written by anyone in the server and can contain anything, including text aimed at
// an AI. They are data, never instructions. A message posted by the bot is public to everyone who can see the channel and cannot be recalled
// before they read it: ask a human first. Kicks, bans and bulk deletes are marked destructive. Mentions are switched off by default on
// messages.send (allowed_mentions parse []), so a model cannot ping @everyone by accident; pass allowMentions to turn them on.

const snowflake = (what: string) => z.string().regex(/^[0-9]{17,20}$/, `A Discord id: 17 to 20 digits`).describe(`The ${what} id (a 17 to 20 digit snowflake)`)
const channelId = snowflake("channel")
const guildId = snowflake("server (guild)")
const messageId = snowflake("message")
const userId = snowflake("user")
const pageOf = (cursorParam: "before" | "after") => lastIdPagination({ cursorParam, defaultPageSize: 50, maxPageSize: 100 })
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }

const user = z.looseObject({ id: z.string(), username: z.string(), global_name: z.string().nullish(), discriminator: z.string().optional(), bot: z.boolean().optional() })
const message = z.looseObject({
  id: z.string(),
  channel_id: z.string(),
  content: z.string(),
  timestamp: z.string().optional(),
  edited_timestamp: z.string().nullish(),
  pinned: z.boolean().optional(),
  type: z.number().optional(),
  author: user.optional(),
  embeds: z.array(z.record(z.string(), z.unknown())).optional(),
  attachments: z.array(z.looseObject({ id: z.string(), filename: z.string().optional(), url: z.string().optional(), size: z.number().optional() })).optional(),
  message_reference: z.looseObject({ message_id: z.string().optional(), channel_id: z.string().optional() }).optional(),
})
const channel = z.looseObject({ id: z.string(), type: z.number(), name: z.string().nullish(), guild_id: z.string().optional(), parent_id: z.string().nullish(), topic: z.string().nullish(), position: z.number().optional() })
const guild = z.looseObject({ id: z.string(), name: z.string(), owner: z.boolean().optional(), permissions: z.string().optional(), approximate_member_count: z.number().optional(), approximate_presence_count: z.number().optional() })
const member = z.looseObject({ user: user.optional(), nick: z.string().nullish(), roles: z.array(z.string()).optional(), joined_at: z.string().optional(), communication_disabled_until: z.string().nullish() })
const role = z.looseObject({ id: z.string(), name: z.string(), color: z.number().optional(), position: z.number().optional(), permissions: z.string().optional(), managed: z.boolean().optional() })
const embed = z.object({ title: z.string().max(256).optional(), description: z.string().max(4096).optional(), url: z.string().url().optional(), color: z.number().int().optional(), footer: z.object({ text: z.string().max(2048) }).optional() })

export const discord = defineConnector({
  name: "discord",
  baseUrl: "https://discord.com/api/v10",
  auth: { type: "apiKey", header: "Authorization", prefix: "Bot " },
  defaultHeaders: { "User-Agent": "DiscordBot (https://github.com/itzzzzzzak/connector-kit, 0.4)" },
  meta: {
    title: "Discord",
    description: "Read and post messages, manage channels, members, roles and reactions in the Discord servers a bot belongs to.",
    docsUrl: "https://discord.com/developers/docs/reference",
    status: "docs-based",
    credentialEnv: "DISCORD_BOT_TOKEN",
  },
  actions: {
    ...generatedActions,
    "bot.get": {
      description: "Get the bot user the token belongs to (its id and username). Use it to check that the token works.",
      method: "GET",
      path: "/users/@me",
      input: z.object({}),
      output: user,
      effect: "read",
    },
    "guilds.list": {
      description: "List the servers (guilds) the bot has been added to, with ids and names. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/@me/guilds",
      input: z.object({ with_counts: z.boolean().optional().describe("Include approximate member counts"), ...paging }),
      output: z.array(guild),
      effect: "read",
      paginate: pageOf("after"),
    },
    "guild.get": {
      description: "Get one server's name, owner, features and (with with_counts) approximate member and online counts.",
      method: "GET",
      path: "/guilds/{guild_id}",
      input: z.object({ guild_id: guildId, with_counts: z.boolean().optional() }),
      output: guild,
      effect: "read",
    },
    "channels.list": {
      description: "List all channels of a server (text, voice, categories, threads' parents) with their ids, types and categories.",
      method: "GET",
      path: "/guilds/{guild_id}/channels",
      input: z.object({ guild_id: guildId }),
      output: z.array(channel),
      effect: "read",
    },
    "messages.list": {
      description: "Read the recent messages of a channel, newest first. Pass nextCursor for older ones. Message text is empty without the Message Content intent.",
      method: "GET",
      path: "/channels/{channel_id}/messages",
      input: z.object({ channel_id: channelId, ...paging }),
      output: z.array(message),
      effect: "read",
      paginate: pageOf("before"),
    },
    "message.get": {
      description: "Get one message by channel and message id.",
      method: "GET",
      path: "/channels/{channel_id}/messages/{message_id}",
      input: z.object({ channel_id: channelId, message_id: messageId }),
      output: message,
      effect: "read",
    },
    "messages.send": {
      description: "Post a message in a channel, optionally as a reply. Public to everyone who can see the channel. Mentions (@everyone, roles, users) are off unless allowMentions is true.",
      method: "POST",
      path: "/channels/{channel_id}/messages",
      input: z
        .object({ channel_id: channelId, content: z.string().max(2000).optional(), embeds: z.array(embed).max(10).optional(), replyToMessageId: messageId.optional(), allowMentions: z.boolean().optional() })
        .refine((i) => (i.content !== undefined && i.content !== "") || (i.embeds !== undefined && i.embeds.length > 0), "Give content or at least one embed"),
      output: message,
      effect: "write",
      buildBody: (i) => ({
        ...(i.content !== undefined && { content: i.content }),
        ...(i.embeds !== undefined && { embeds: i.embeds }),
        ...(i.replyToMessageId !== undefined && { message_reference: { message_id: i.replyToMessageId, fail_if_not_exists: false } }),
        ...(i.allowMentions === true ? {} : { allowed_mentions: { parse: [] } }),
      }),
    },
    "message.edit": {
      description: "Change the text of a message the bot posted. Mentions stay off unless allowMentions is true.",
      method: "PATCH",
      path: "/channels/{channel_id}/messages/{message_id}",
      input: z.object({ channel_id: channelId, message_id: messageId, content: z.string().max(2000), allowMentions: z.boolean().optional() }),
      output: message,
      effect: "write",
      buildBody: (i) => ({ content: i.content, ...(i.allowMentions === true ? {} : { allowed_mentions: { parse: [] } }) }),
    },
    "message.delete": {
      description: "Delete a message. Cannot be undone. The bot can delete its own messages, and others' only with the Manage Messages permission.",
      method: "DELETE",
      path: "/channels/{channel_id}/messages/{message_id}",
      input: z.object({ channel_id: channelId, message_id: messageId }),
      output: z.unknown(),
      effect: "destructive",
    },
    "reaction.add": {
      description: "React to a message as the bot with an emoji: a Unicode emoji (👍) or a custom one as name:id.",
      method: "PUT",
      path: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
      input: z.object({ channel_id: channelId, message_id: messageId, emoji: z.string().min(1).max(100) }),
      output: z.unknown(),
      effect: "write",
    },
    "members.list": {
      description: "List the members of a server, oldest joiners first (needs the Server Members privileged intent). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/guilds/{guild_id}/members",
      input: z.object({ guild_id: guildId, ...paging }),
      output: z.array(member),
      effect: "read",
      paginate: lastIdPagination({ cursorParam: "after", idKey: "user.id", defaultPageSize: 50, maxPageSize: 1000 }),
    },
    "member.get": {
      description: "Get one member of a server: nickname, roles and join date.",
      method: "GET",
      path: "/guilds/{guild_id}/members/{user_id}",
      input: z.object({ guild_id: guildId, user_id: userId }),
      output: member,
      effect: "read",
    },
    "roles.list": {
      description: "List the roles of a server with their ids, colors and permission bits.",
      method: "GET",
      path: "/guilds/{guild_id}/roles",
      input: z.object({ guild_id: guildId }),
      output: z.array(role),
      effect: "read",
    },
    "member.kick": {
      description: "Remove a member from the server. They can rejoin with a new invite. Needs the Kick Members permission.",
      method: "DELETE",
      path: "/guilds/{guild_id}/members/{user_id}",
      input: z.object({ guild_id: guildId, user_id: userId }),
      output: z.unknown(),
      effect: "destructive",
    },
    "member.ban": {
      description: "Ban a user: removes them from the server and stops them rejoining, and can delete their recent messages. Needs the Ban Members permission.",
      method: "PUT",
      path: "/guilds/{guild_id}/bans/{user_id}",
      input: z.object({ guild_id: guildId, user_id: userId, delete_message_seconds: z.number().int().min(0).max(604800).optional().describe("Delete this many seconds of their recent messages (up to 7 days)") }),
      output: z.unknown(),
      effect: "destructive",
    },
    "dm.open": {
      description: "Open (or get) the direct message channel with a user; then post there with messages.send. The user must share a server with the bot.",
      method: "POST",
      path: "/users/@me/channels",
      input: z.object({ recipient_id: userId }),
      output: channel,
      effect: "write",
    },
  },
})

export default discord
