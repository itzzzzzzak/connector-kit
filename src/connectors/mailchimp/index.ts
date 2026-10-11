import { defineConnector, offsetPagination } from "../../index.js"
import { z } from "zod"

// Facts from Mailchimp's official Marketing API schema (api.mailchimp.com/schema/3.0) and quick start: base URL
// https://{dc}.api.mailchimp.com/3.0 where {dc} is the data center that ends your API key (us19 in "...-us19"), HTTP
// Basic with ANY username and the API key as the password, `count` (default 10, max 1000) + `offset` paging with
// `total_items` in each response, collections named `lists` / `members` / `campaigns`, and "Add or update list member"
// as a PUT whose path accepts the member's email address (or MD5 hash, or contact id).
//
// PRIVACY/CONSENT: adding or changing a subscriber is a consent matter. The single write here requires an explicit
// subscription status for new people and is described to a model as something to do only when asked.
// Mailchimp's OAuth is not declared (an API key is used).

const list = z.object({
  id: z.string(),
  web_id: z.number().optional(),
  name: z.string().optional(),
  date_created: z.string().optional(),
  visibility: z.string().optional(),
  double_optin: z.boolean().optional(),
  stats: z.object({ member_count: z.number().optional(), unsubscribe_count: z.number().optional(), cleaned_count: z.number().optional(), open_rate: z.number().optional(), click_rate: z.number().optional() }).optional(),
  contact: z.object({ company: z.string().optional(), country: z.string().optional() }).optional(),
})
const member = z.object({
  id: z.string().describe("MD5 hash of the lowercase email address"),
  email_address: z.string(),
  unique_email_id: z.string().optional(),
  contact_id: z.string().optional(),
  full_name: z.string().optional(),
  status: z.string().optional().describe("subscribed, unsubscribed, cleaned, pending, transactional or archived"),
  merge_fields: z.record(z.string(), z.unknown()).optional(),
  language: z.string().optional(),
  vip: z.boolean().optional(),
  timestamp_signup: z.string().optional(),
  last_changed: z.string().optional(),
  tags: z.array(z.object({ id: z.number().optional(), name: z.string() })).optional(),
  list_id: z.string().optional(),
})
const campaign = z.object({
  id: z.string(),
  web_id: z.number().optional(),
  type: z.string().optional(),
  status: z.string().optional().describe("save, paused, schedule, sending or sent"),
  create_time: z.string().optional(),
  send_time: z.string().nullish(),
  emails_sent: z.number().optional(),
  archive_url: z.string().optional(),
  recipients: z.object({ list_id: z.string().optional(), list_name: z.string().optional(), recipient_count: z.number().optional() }).optional(),
  settings: z.object({ subject_line: z.string().nullish(), title: z.string().nullish(), from_name: z.string().nullish(), reply_to: z.string().nullish() }).optional(),
  report_summary: z.object({ opens: z.number().optional(), unique_opens: z.number().optional(), open_rate: z.number().optional(), clicks: z.number().optional(), click_rate: z.number().optional() }).optional(),
})

const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = (itemsKey: string) => offsetPagination({ itemsKey, pageSizeParam: "count", totalPath: ["total_items"], defaultPageSize: 30, maxPageSize: 100 })
const listId = z.string().describe("An audience (list) id, from lists.list")
const subscriber = z.string().describe("The member's email address (or the MD5 hash of the lowercase address, or the contact id)")
const sortDir = z.enum(["ASC", "DESC"]).optional()

export const mailchimp = defineConnector({
  name: "mailchimp",
  baseUrl: "https://{dc}.api.mailchimp.com/3.0",
  variables: { dc: { description: 'Your data center: the part of the API key after the dash, such as "us19"', example: "us19", pattern: "[a-z]{2}\\d{1,2}" } },
  // Credential format: "anystring:YOUR_API_KEY" (the username is ignored; the key goes after the colon).
  auth: { type: "basic" },
  meta: {
    title: "Mailchimp",
    description: "Read audiences, subscribers and campaigns; add or update a subscriber.",
    docsUrl: "https://mailchimp.com/developer/marketing/api/",
    status: "docs-based",
    credentialEnv: "MAILCHIMP_CREDENTIALS",
  },
  actions: {
    "ping.get": {
      description: "Check that the Mailchimp credentials and data center work. Returns a health status.",
      method: "GET",
      path: "/ping",
      input: z.object({}),
      output: z.object({ health_status: z.string() }),
      effect: "read",
    },
    "lists.list": {
      description: "List audiences (Mailchimp calls them lists), with subscriber counts. Use first to find an audience id. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/lists",
      input: z.object({ email: z.string().optional().describe("Only audiences this email address is subscribed to"), sort_field: z.literal("date_created").optional(), sort_dir: sortDir, ...paging }),
      output: z.array(list),
      effect: "read",
      paginate: pagination("lists"),
    },
    "lists.get": {
      description: "Get one audience by id: name, subscriber, unsubscribe and cleaned counts, and open and click rates.",
      method: "GET",
      path: "/lists/{list_id}",
      input: z.object({ list_id: listId }),
      output: list,
      effect: "read",
    },
    "members.list": {
      description: "List the subscribers of an audience. Filter by status (subscribed, unsubscribed, cleaned, pending) or by when they last changed. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/lists/{list_id}/members",
      input: z.object({
        list_id: listId,
        status: z.enum(["subscribed", "unsubscribed", "cleaned", "pending", "transactional", "archived"]).optional(),
        since_last_changed: z.string().optional().describe("ISO 8601; only members changed after this"),
        vip_only: z.boolean().optional(),
        sort_field: z.enum(["timestamp_opt", "timestamp_signup", "last_changed"]).optional(),
        sort_dir: sortDir,
        ...paging,
      }),
      output: z.array(member),
      effect: "read",
      paginate: pagination("members"),
    },
    "members.get": {
      description: "Get one subscriber of an audience by email address: their status, merge fields (name, phone...) and tags.",
      method: "GET",
      path: "/lists/{list_id}/members/{subscriber_hash}",
      input: z.object({ list_id: listId, subscriber_hash: subscriber }),
      output: member,
      effect: "read",
    },
    "members.upsert": {
      description:
        "Add a person to an audience, or update them if they are already there. This CHANGES WHO RECEIVES the user's emails and has consent implications: only use when the user clearly asked, and never subscribe someone who has not agreed. status_if_new is required: use pending to send a confirmation email first.",
      method: "PUT",
      path: "/lists/{list_id}/members/{subscriber_hash}",
      input: z.object({
        list_id: listId,
        subscriber_hash: subscriber,
        email_address: z.string().email(),
        status_if_new: z.enum(["subscribed", "unsubscribed", "cleaned", "pending", "transactional"]).describe("Status for a NEW member. Use pending for double opt-in."),
        status: z.enum(["subscribed", "unsubscribed", "cleaned", "pending", "transactional"]).optional().describe("Status to set on an EXISTING member"),
        merge_fields: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('For example { "FNAME": "Ada", "LNAME": "Lovelace" }'),
        language: z.string().max(10).optional(),
        vip: z.boolean().optional(),
      }),
      output: member,
      effect: "write",
      safeToRetry: true, // "add or update": repeating the same PUT leaves the member in the same state
    },
    "campaigns.list": {
      description: "List email campaigns with status, send time, recipient count and subject line. Filter by status, type or audience. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/campaigns",
      input: z.object({
        status: z.enum(["save", "paused", "schedule", "sending", "sent"]).optional(),
        type: z.enum(["regular", "plaintext", "absplit", "rss", "variate"]).optional(),
        list_id: z.string().optional().describe("Only campaigns sent to this audience"),
        since_send_time: z.string().optional().describe("ISO 8601"),
        before_send_time: z.string().optional().describe("ISO 8601"),
        sort_field: z.enum(["create_time", "send_time"]).optional(),
        sort_dir: sortDir,
        ...paging,
      }),
      output: z.array(campaign),
      effect: "read",
      paginate: pagination("campaigns"),
    },
    "campaigns.get": {
      description: "Get one campaign by id: subject, status, recipients and the open and click summary.",
      method: "GET",
      path: "/campaigns/{campaign_id}",
      input: z.object({ campaign_id: z.string() }),
      output: campaign,
      effect: "read",
    },
  },
})

export default mailchimp
