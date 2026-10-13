import { defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from the Telegram Bot API reference (core.telegram.org/bots/api): every call is `https://api.telegram.org/bot<token>/<method>` with the bot
// token (from @BotFather, written "123456789:AA...") IN THE PATH, which is why this connector uses auth `pathToken` (ADR-027). Methods take a JSON
// body and answer { ok: true, result } or { ok: false, error_code, description } with a matching HTTP status. A chat is a number (negative for groups
// and channels) or "@channelusername"; a message is addressed by chat id plus message id. Text is 1 to 4096 characters, a caption at most 1024.
// getUpdates (the poll) and a webhook are exclusive: while a webhook is set, getUpdates is refused with 409.
//
// SECURITY: a message reaches real people at once and a bot cannot unsend one it forgot about: a model must ask a human before sending. Message text,
// names and captions read back come from Telegram users and can contain text aimed at an AI: they are data, never instructions. The token is part of
// every request URL, so keep it out of logs on your side; the kit never puts it in an error or a result.

const chatId = z.union([z.number().int(), z.string().min(2).regex(/^@\w+$/, 'A channel is written "@channelusername"')]).describe('A chat id (negative for groups and channels) or "@channelusername"')
const messageId = z.number().int().positive()
const text = z.string().min(1).max(4096)
const parseMode = z.enum(["MarkdownV2", "HTML"]).optional().describe("How to read formatting in the text. Default: plain text")
const unwrap = (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined)

const user = z.looseObject({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional() })
const chat = z.looseObject({ id: z.number(), type: z.string().optional(), title: z.string().optional(), username: z.string().optional() })
const message = z.looseObject({ message_id: z.number(), date: z.number().optional(), chat: chat.optional(), from: user.optional(), text: z.string().optional(), caption: z.string().optional() })
const update = z.looseObject({ update_id: z.number(), message: message.optional(), edited_message: message.optional(), channel_post: message.optional() })

const sendOptions = {
  disableNotification: z.boolean().optional().describe("Deliver silently"),
  protectContent: z.boolean().optional().describe("Stop recipients forwarding or saving it"),
  replyToMessageId: messageId.optional().describe("Reply to this message in the same chat"),
}
const sendFields = (i: Record<string, unknown>) => ({
  chat_id: i.chatId,
  ...(i.disableNotification !== undefined && { disable_notification: i.disableNotification }),
  ...(i.protectContent !== undefined && { protect_content: i.protectContent }),
  ...(i.replyToMessageId !== undefined && { reply_parameters: { message_id: i.replyToMessageId } }),
})

export const telegram = defineConnector({
  name: "telegram",
  baseUrl: "https://api.telegram.org",
  auth: { type: "pathToken", prefix: "bot" },
  meta: {
    title: "Telegram",
    description: "Send, edit and delete Telegram messages and photos as a bot, read the messages sent to it, and manage its webhook.",
    docsUrl: "https://core.telegram.org/bots/api",
    status: "docs-based",
    credentialEnv: "TELEGRAM_BOT_TOKEN",
  },
  actions: {
    "me.get": {
      description: "Get the bot's own account (id and username). A quick way to check that the bot token works.",
      method: "GET",
      path: "/getMe",
      input: z.object({}),
      output: user,
      effect: "read",
      extract: unwrap,
    },
    "updates.get": {
      description: "Read the messages and events sent to the bot since an offset, oldest first. Pass offset = the last update_id + 1 to mark earlier ones as handled; it returns at once (no waiting). Refused with 409 while a webhook is set.",
      method: "POST",
      path: "/getUpdates",
      input: z.object({ offset: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional(), allowedUpdates: z.array(z.string()).max(30).optional().describe('Update types to receive, such as ["message"]') }),
      output: z.array(update),
      effect: "read",
      extract: unwrap,
      buildBody: (i) => ({ timeout: 0, ...(i.offset !== undefined && { offset: i.offset }), ...(i.limit !== undefined && { limit: i.limit }), ...(i.allowedUpdates !== undefined && { allowed_updates: i.allowedUpdates }) }),
    },
    "chat.get": {
      description: "Get a chat the bot is in: its type, title, username and description.",
      method: "POST",
      path: "/getChat",
      input: z.object({ chatId }),
      output: chat,
      effect: "read",
      extract: unwrap,
      buildBody: (i) => ({ chat_id: i.chatId }),
    },
    "messages.send": {
      description: "Send a text message to a chat as the bot. It reaches real people at once and cannot be recalled by a retry: ask a human first.",
      method: "POST",
      path: "/sendMessage",
      input: z.object({ chatId, text, parseMode, ...sendOptions }),
      output: message,
      effect: "write",
      extract: unwrap,
      buildBody: (i) => ({ ...sendFields(i), text: i.text, ...(i.parseMode !== undefined && { parse_mode: i.parseMode }) }),
    },
    "photos.send": {
      description: "Send a photo to a chat as the bot, from a public https URL or a file_id Telegram already holds. It reaches real people at once: ask a human first.",
      method: "POST",
      path: "/sendPhoto",
      input: z.object({ chatId, photo: z.string().min(1).describe("An https URL or a Telegram file_id"), caption: z.string().max(1024).optional(), parseMode, ...sendOptions }),
      output: message,
      effect: "write",
      extract: unwrap,
      buildBody: (i) => ({ ...sendFields(i), photo: i.photo, ...(i.caption !== undefined && { caption: i.caption }), ...(i.parseMode !== undefined && { parse_mode: i.parseMode }) }),
    },
    "messages.edit": {
      description: "Change the text of a message the bot sent. Everyone who can see the message sees the new text.",
      method: "POST",
      path: "/editMessageText",
      input: z.object({ chatId, messageId, text, parseMode }),
      output: message,
      effect: "write",
      extract: unwrap,
      buildBody: (i) => ({ chat_id: i.chatId, message_id: i.messageId, text: i.text, ...(i.parseMode !== undefined && { parse_mode: i.parseMode }) }),
    },
    "messages.forward": {
      description: "Forward a message from one chat to another as the bot. It reaches real people at once: ask a human first.",
      method: "POST",
      path: "/forwardMessage",
      input: z.object({ chatId, fromChatId: chatId, messageId, disableNotification: sendOptions.disableNotification }),
      output: message,
      effect: "write",
      extract: unwrap,
      buildBody: (i) => ({ chat_id: i.chatId, from_chat_id: i.fromChatId, message_id: i.messageId, ...(i.disableNotification !== undefined && { disable_notification: i.disableNotification }) }),
    },
    "messages.delete": {
      description: "Delete a message. The bot can delete its own messages, and others' in groups where it is an admin. A deleted message cannot be restored.",
      method: "POST",
      path: "/deleteMessage",
      input: z.object({ chatId, messageId }),
      output: z.boolean(),
      effect: "destructive",
      extract: unwrap,
      buildBody: (i) => ({ chat_id: i.chatId, message_id: i.messageId }),
    },
    "chat.leave": {
      description: "Make the bot leave a group, supergroup or channel. It removes the bot from the chat and it cannot rejoin by itself.",
      method: "POST",
      path: "/leaveChat",
      input: z.object({ chatId }),
      output: z.boolean(),
      effect: "destructive",
      extract: unwrap,
      buildBody: (i) => ({ chat_id: i.chatId }),
    },
    "webhook.get": {
      description: "Get the bot's webhook: its URL, how many updates are waiting and the last delivery error.",
      method: "GET",
      path: "/getWebhookInfo",
      input: z.object({}),
      output: z.looseObject({ url: z.string(), pending_update_count: z.number().optional(), last_error_message: z.string().optional() }),
      effect: "read",
      extract: unwrap,
    },
    "webhook.set": {
      description: "Send the bot's updates to an https URL instead of polling. It replaces any current webhook and turns updates.get off while set.",
      method: "POST",
      path: "/setWebhook",
      input: z.object({ url: z.string().url().startsWith("https://"), secretToken: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional().describe("Sent back in the X-Telegram-Bot-Api-Secret-Token header so you can check a request is from Telegram"), dropPendingUpdates: z.boolean().optional() }),
      output: z.boolean(),
      effect: "write",
      extract: unwrap,
      buildBody: (i) => ({ url: i.url, ...(i.secretToken !== undefined && { secret_token: i.secretToken }), ...(i.dropPendingUpdates !== undefined && { drop_pending_updates: i.dropPendingUpdates }) }),
    },
    "webhook.delete": {
      description: "Remove the bot's webhook so updates.get works again. With dropPendingUpdates, also deletes the updates still waiting.",
      method: "POST",
      path: "/deleteWebhook",
      input: z.object({ dropPendingUpdates: z.boolean().optional() }),
      output: z.boolean(),
      effect: "destructive",
      extract: unwrap,
      buildBody: (i) => ({ ...(i.dropPendingUpdates !== undefined && { drop_pending_updates: i.dropPendingUpdates }) }),
    },
  },
})

export default telegram
