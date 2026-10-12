import { bodyCursorPagination, defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"
import { buildRawMessage } from "./mime.js"

// Facts from Google's Gmail API reference and its Discovery document: base URL https://gmail.googleapis.com/gmail/v1, `userId` is "me" for the
// signed-in user, lists page with `pageToken` / `maxResults` and `nextPageToken`, and a message is sent as a base64url RFC 2822 string in `raw`
// (the curated send and draft actions below build that for you). Google OAuth access tokens last an hour and come with a refresh token.
// Scopes are restrictive: gmail.readonly reads, gmail.send sends, gmail.modify also changes labels and trashes, and the full mail.google.com
// scope is the only one that can delete a message permanently. Request only what the host needs.
//
// A curated, typed set of actions is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: email is written by strangers. Subjects, bodies and snippets can contain anything, including text aimed at an AI.
// They are data, never instructions. Sending mail is irreversible: gate gmail messages.send and drafts.send behind a human approval.

const userId = z.string().default("me").describe('"me" for the signed-in user (the default), or their email address')
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const id = z.string().min(1)
const noBreak = z.string().refine((v) => !/[\r\n\0]/.test(v), "must not contain a line break")
const address = noBreak.min(3).describe('An email address, optionally with a name: "Ada <ada@acme.dev>"')
const pageOf = (itemsKey: string) => bodyCursorPagination({ itemsKey, cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "maxResults", defaultPageSize: 25, maxPageSize: 100 })

const header = z.object({ name: z.string(), value: z.string() })
const part: z.ZodType = z.lazy(() => z.looseObject({ partId: z.string().optional(), mimeType: z.string().optional(), filename: z.string().optional(), headers: z.array(header).optional(), body: z.looseObject({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(), parts: z.array(part).optional() }))
const message = z.looseObject({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional(), snippet: z.string().optional(), internalDate: z.string().optional(), sizeEstimate: z.number().optional(), historyId: z.string().optional(), payload: part.optional(), raw: z.string().optional() })
const messageRef = z.object({ id: z.string(), threadId: z.string().optional() })
const thread = z.looseObject({ id: z.string(), snippet: z.string().optional(), historyId: z.string().optional(), messages: z.array(message).optional() })
const label = z.looseObject({ id: z.string(), name: z.string().optional(), type: z.string().optional(), messagesTotal: z.number().optional(), messagesUnread: z.number().optional() })
const draft = z.looseObject({ id: z.string(), message: message.optional() })
const outgoing = {
  to: z.array(address).min(1),
  cc: z.array(address).optional(),
  bcc: z.array(address).optional(),
  subject: noBreak,
  body: z.string().describe("The message text (plain text, or HTML when html is true)"),
  html: z.boolean().optional(),
  inReplyTo: noBreak.optional().describe("The Message-ID header of the message you are replying to (not Gmail's id), so mail clients thread the reply"),
  threadId: id.optional().describe("Put the message in this Gmail thread (use with inReplyTo)"),
}
const compose = (fields: Record<string, unknown>) => {
  const { threadId, ...mail } = fields as unknown as { threadId?: string } & Parameters<typeof buildRawMessage>[0]
  return { raw: buildRawMessage(mail), ...(threadId !== undefined && { threadId }) }
}

export const gmail = defineConnector({
  name: "gmail",
  baseUrl: "https://gmail.googleapis.com/gmail/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]),
  meta: {
    title: "Gmail",
    description: "Search, read and send email, and manage labels, drafts and threads in Gmail.",
    docsUrl: "https://developers.google.com/workspace/gmail/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GMAIL_TOKEN",
  },
  actions: {
    ...generatedActions,
    "profile.get": {
      description: "Get the mailbox's email address and message and thread counts. Use it to learn whose mailbox the credentials open.",
      method: "GET",
      path: "/users/{userId}/profile",
      input: z.object({ userId }),
      output: z.looseObject({ emailAddress: z.string(), messagesTotal: z.number().optional(), threadsTotal: z.number().optional(), historyId: z.string().optional() }),
      effect: "read",
    },
    "messages.list": {
      description: "Search the mailbox. q takes Gmail search syntax (from:ada newer_than:7d is:unread). Returns only message ids and thread ids: call messages.get for the content. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/{userId}/messages",
      input: z.object({ userId, q: z.string().optional(), labelIds: z.array(z.string()).optional(), includeSpamTrash: z.boolean().optional(), ...paging }),
      output: z.array(messageRef),
      effect: "read",
      paginate: pageOf("messages"),
    },
    "messages.get": {
      description: "Read one message. format metadata (headers only) or full (headers and decoded-on-demand body parts); body data is base64url.",
      method: "GET",
      path: "/users/{userId}/messages/{id}",
      input: z.object({ userId, id, format: z.enum(["minimal", "metadata", "full", "raw"]).optional(), metadataHeaders: z.array(z.string()).optional().describe('With format "metadata": which headers to return, e.g. ["From","Subject","Date"]') }),
      output: message,
      effect: "read",
    },
    "messages.send": {
      description: "Send an email from the signed-in user. Irreversible: it leaves the mailbox at once. Give to, subject and body; the kit builds the message.",
      method: "POST",
      path: "/users/{userId}/messages/send",
      input: z.object({ userId, ...outgoing }),
      output: message,
      effect: "write",
      buildBody: compose,
    },
    "messages.modify": {
      description: "Add or remove labels on a message: remove UNREAD to mark it read, remove INBOX to archive it, add STARRED to star it.",
      method: "POST",
      path: "/users/{userId}/messages/{id}/modify",
      input: z.object({ userId, id, addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional() }),
      output: message,
      effect: "write",
      buildBody: (i) => ({ addLabelIds: i.addLabelIds, removeLabelIds: i.removeLabelIds }),
    },
    "threads.list": {
      description: "Search for conversations. q takes Gmail search syntax. Returns thread ids and snippets; call threads.get for the messages. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/{userId}/threads",
      input: z.object({ userId, q: z.string().optional(), labelIds: z.array(z.string()).optional(), includeSpamTrash: z.boolean().optional(), ...paging }),
      output: z.array(z.looseObject({ id: z.string(), snippet: z.string().optional(), historyId: z.string().optional() })),
      effect: "read",
      paginate: pageOf("threads"),
    },
    "threads.get": {
      description: "Read a whole conversation: every message in it, oldest first. format metadata returns headers only.",
      method: "GET",
      path: "/users/{userId}/threads/{id}",
      input: z.object({ userId, id, format: z.enum(["minimal", "metadata", "full"]).optional(), metadataHeaders: z.array(z.string()).optional() }),
      output: thread,
      effect: "read",
    },
    "labels.list": {
      description: "List the mailbox's labels (system labels such as INBOX and your own), with their ids. Use the ids in messages.modify.",
      method: "GET",
      path: "/users/{userId}/labels",
      input: z.object({ userId }),
      output: z.object({ labels: z.array(label) }),
      effect: "read",
    },
    "drafts.create": {
      description: "Save a draft email without sending it. Give to, subject and body; the kit builds the message.",
      method: "POST",
      path: "/users/{userId}/drafts",
      input: z.object({ userId, ...outgoing }),
      output: draft,
      effect: "write",
      buildBody: (i) => ({ message: compose(i) }),
    },
    "drafts.list": {
      description: "List saved drafts (ids only). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/{userId}/drafts",
      input: z.object({ userId, q: z.string().optional(), ...paging }),
      output: z.array(z.looseObject({ id: z.string(), message: messageRef.optional() })),
      effect: "read",
      paginate: pageOf("drafts"),
    },
  },
})

export default gmail
