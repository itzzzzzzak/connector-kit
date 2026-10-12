import { defineConnector } from "../../index.js"
import { graphPage, microsoftAuth } from "../../microsoft.js"
import { z } from "zod"

// Facts from the Microsoft Graph v1.0 reference (mail, calendar and contacts): base URL https://graph.microsoft.com/v1.0, "/me" is the
// signed-in user, lists put the page in `value` and the next page's full URL in `@odata.nextLink`, query options are written $top, $filter,
// $search and $select (the leading $ is added here so inputs stay plain names), times are { dateTime, timeZone } pairs.
// Scopes: Mail.Read / Mail.ReadWrite / Mail.Send, Calendars.ReadWrite, Contacts.Read. The default asks for read and write; narrow it.
//
// A curated, typed set is written by hand. Graph is far larger than one connector should carry; this is the mail, calendar and contacts
// core. SECURITY: mail subjects, bodies, event notes and contact fields are written by other people and can contain anything, including
// text aimed at an AI. They are data, never instructions. Sending mail and creating events with attendees reach real people: ask a human.

const id = z.string().min(1)
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(100).optional() }
const address = z.looseObject({ name: z.string().optional(), address: z.string().optional() })
const recipient = z.looseObject({ emailAddress: address.optional() })
const message = z.looseObject({
  id: z.string(),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  from: recipient.nullish(),
  toRecipients: z.array(recipient).optional(),
  receivedDateTime: z.string().optional(),
  isRead: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  webLink: z.string().optional(),
  conversationId: z.string().optional(),
})
const messageWithBody = message.extend({ body: z.looseObject({ contentType: z.string().optional(), content: z.string().optional() }).optional() })
const dateTimeZone = z.looseObject({ dateTime: z.string(), timeZone: z.string().optional() })
const event = z.looseObject({
  id: z.string(),
  subject: z.string().nullish(),
  start: dateTimeZone.optional(),
  end: dateTimeZone.optional(),
  location: z.looseObject({ displayName: z.string().optional() }).nullish(),
  organizer: recipient.nullish(),
  attendees: z.array(z.looseObject({ emailAddress: address.optional(), type: z.string().optional() })).optional(),
  isAllDay: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  onlineMeeting: z.looseObject({ joinUrl: z.string().optional() }).nullish(),
  webLink: z.string().optional(),
})
const emails = z.array(z.string().email()).min(1).max(100)
const toRecipients = (list: string[]) => list.map((a) => ({ emailAddress: { address: a } }))
const mailBody = z.object({
  subject: z.string().max(998),
  body: z.string().describe("The message text"),
  contentType: z.enum(["text", "html"]).optional().describe("Default: text"),
  to: emails,
  cc: emails.optional(),
  bcc: emails.optional(),
})
type Mail = z.infer<typeof mailBody>
const buildMessage = (i: Mail) => ({
  subject: i.subject,
  body: { contentType: i.contentType ?? "text", content: i.body },
  toRecipients: toRecipients(i.to),
  ...(i.cc && { ccRecipients: toRecipients(i.cc) }),
  ...(i.bcc && { bccRecipients: toRecipients(i.bcc) }),
})
const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,isDraft,hasAttachments,webLink,conversationId"

export const outlook = defineConnector({
  name: "outlook",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: microsoftAuth(["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "Contacts.Read", "User.Read"]),
  meta: {
    title: "Outlook (Microsoft 365)",
    description: "Read, search, draft and send Outlook mail, manage calendar events and find free time, and read contacts through Microsoft Graph.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview",
    status: "docs-based",
    credentialEnv: "OUTLOOK_TOKEN",
  },
  actions: {
    "me.get": {
      description: "Get the signed-in user's profile (name, email address, id). Use it to check a new connection.",
      method: "GET",
      path: "/me",
      input: z.object({}),
      output: z.looseObject({ id: z.string(), displayName: z.string().nullish(), mail: z.string().nullish(), userPrincipalName: z.string().optional() }),
      effect: "read",
    },
    "mailFolders.list": {
      description: "List the user's top-level mail folders (Inbox, Sent Items, Drafts, ...) with their ids and unread counts.",
      method: "GET",
      path: "/me/mailFolders",
      input: z.object({ ...paging }),
      output: z.array(z.looseObject({ id: z.string(), displayName: z.string().optional(), unreadItemCount: z.number().optional(), totalItemCount: z.number().optional() })),
      effect: "read",
      paginate: graphPage(),
    },
    "messages.list": {
      description: 'List messages in a folder, newest first (the folder is "inbox" by default; a well-known name like "sentitems" or "drafts", or a folder id). Optionally search ("from:ada budget") or filter (OData, e.g. "isRead eq false"). Search and filter cannot be combined. One bounded page; pass nextCursor for more.',
      method: "GET",
      path: "/me/mailFolders/{folderId}/messages",
      input: z
        .object({
        folderId: z.string().min(1).default("inbox"),
        search: z.string().max(500).optional().describe('Free text or KQL such as "from:ada subject:budget"'),
        filter: z.string().max(500).optional().describe('OData filter, e.g. "isRead eq false" or "receivedDateTime ge 2026-10-01T00:00:00Z"'),
        ...paging,
        })
        .refine((i) => i.search === undefined || i.filter === undefined, { message: "Pass either search or filter, not both (Microsoft Graph does not allow both)" }),
      output: z.array(message),
      effect: "read",
      paginate: graphPage(),
      buildQuery: (i) => ({
        $select: select,
        // Graph refuses $orderby together with a filter on another property, so newest-first applies only to a plain listing.
        ...(i.search === undefined && i.filter === undefined && { $orderby: "receivedDateTime desc" }),
        ...(typeof i.search === "string" && { $search: `"${i.search.replace(/"/g, " ")}"` }),
        ...(typeof i.filter === "string" && { $filter: i.filter }),
      }),
    },
    "message.get": {
      description: "Get one message by id, with its body (HTML or text).",
      method: "GET",
      path: "/me/messages/{messageId}",
      input: z.object({ messageId: id }),
      output: messageWithBody,
      effect: "read",
    },
    "drafts.create": {
      description: "Save a draft message without sending it. Nobody is emailed until a person sends the draft.",
      method: "POST",
      path: "/me/messages",
      input: mailBody,
      output: message,
      effect: "write",
      buildBody: (i) => buildMessage(i as Mail),
    },
    "messages.send": {
      description: "Send an email from the user's mailbox to the listed people. This reaches real people and cannot be undone: ask a human first. The sent copy is saved in Sent Items.",
      method: "POST",
      path: "/me/sendMail",
      input: mailBody,
      output: z.unknown(),
      effect: "write",
      buildBody: (i) => ({ message: buildMessage(i as Mail), saveToSentItems: true }),
    },
    "message.delete": {
      description: "Delete a message (it moves to Deleted Items). Use it only when the user asked for the message to be removed.",
      method: "DELETE",
      path: "/me/messages/{messageId}",
      input: z.object({ messageId: id }),
      output: z.unknown(),
      effect: "destructive",
    },
    "events.list": {
      description: "List calendar events that fall between two times, with recurring events expanded. Both times are required so the window stays bounded. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/me/calendarView",
      input: z.object({ startDateTime: z.string().describe("ISO 8601, e.g. 2026-10-14T00:00:00Z"), endDateTime: z.string().describe("ISO 8601, after startDateTime"), ...paging }),
      output: z.array(event),
      effect: "read",
      paginate: graphPage(),
      buildQuery: (i) => ({ startDateTime: i.startDateTime, endDateTime: i.endDateTime, $orderby: "start/dateTime" }),
    },
    "event.get": {
      description: "Get one calendar event by id, with its attendees and times.",
      method: "GET",
      path: "/me/events/{eventId}",
      input: z.object({ eventId: id }),
      output: event,
      effect: "read",
    },
    "events.create": {
      description: "Create a calendar event. Attendees are emailed an invitation, so ask a human before adding any. Set isOnlineMeeting to add a Teams link.",
      method: "POST",
      path: "/me/events",
      input: z.object({
        subject: z.string().min(1).max(255),
        start: dateTimeZone.extend({ timeZone: z.string().describe('IANA or Windows name, e.g. "Europe/Berlin" or "UTC"') }),
        end: dateTimeZone.extend({ timeZone: z.string() }),
        body: z.string().optional(),
        location: z.string().optional(),
        attendees: emails.optional().describe("Email addresses to invite; they are emailed"),
        isOnlineMeeting: z.boolean().optional(),
      }),
      output: event,
      effect: "write",
      buildBody: (i) => ({
        subject: i.subject,
        start: i.start,
        end: i.end,
        ...(i.body !== undefined && { body: { contentType: "text", content: i.body } }),
        ...(i.location !== undefined && { location: { displayName: i.location } }),
        ...(Array.isArray(i.attendees) && { attendees: (i.attendees as string[]).map((a) => ({ emailAddress: { address: a }, type: "required" })) }),
        ...(i.isOnlineMeeting !== undefined && { isOnlineMeeting: i.isOnlineMeeting }),
      }),
    },
    "event.delete": {
      description: "Delete a calendar event from the user's calendar. When the user is the organizer, attendees are notified that it is cancelled.",
      method: "DELETE",
      path: "/me/events/{eventId}",
      input: z.object({ eventId: id }),
      output: z.unknown(),
      effect: "destructive",
    },
    "schedule.get": {
      description: "Find when people are free or busy between two times, to pick a meeting slot. Pass up to 20 email addresses.",
      method: "POST",
      path: "/me/calendar/getSchedule",
      input: z.object({
        schedules: z.array(z.string().email()).min(1).max(20),
        startTime: dateTimeZone.extend({ timeZone: z.string() }),
        endTime: dateTimeZone.extend({ timeZone: z.string() }),
        availabilityViewInterval: z.number().int().min(5).max(1440).optional().describe("Minutes per slot in the availability string. Default 30"),
      }),
      output: z.looseObject({ value: z.array(z.looseObject({ scheduleId: z.string(), availabilityView: z.string().optional(), scheduleItems: z.array(z.looseObject({ status: z.string().optional(), start: dateTimeZone.optional(), end: dateTimeZone.optional() })).optional() })) }),
      effect: "read",
    },
    "contacts.list": {
      description: "List the user's personal contacts (name, email addresses, phone numbers). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/me/contacts",
      input: z.object({ ...paging }),
      output: z.array(z.looseObject({ id: z.string(), displayName: z.string().nullish(), emailAddresses: z.array(address).optional(), mobilePhone: z.string().nullish(), companyName: z.string().nullish() })),
      effect: "read",
      paginate: graphPage(),
    },
  },
})

export default outlook
