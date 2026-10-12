import { bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Twilio SendGrid's v3 Web API reference: base URL https://api.sendgrid.com/v3 (accounts with a regional "EU" subuser use
// https://api.eu.sendgrid.com, which this connector does not cover), `Authorization: Bearer SG....` with an API key whose permissions are chosen
// when it is created, "Send mail" is POST /mail/send that answers 202 with an EMPTY body (the message id is in the X-Message-Id header, which
// this kit does not return), `content` must list text/plain before text/html, a message may have at most 1000 recipients across personalizations,
// dynamic template lists answer { result: [...], _metadata: { next } } with `page_size` (at most 200) and a full next URL, and suppression
// lists (bounces) answer a bare array with `limit` / `offset`. A key that lacks a permission answers 401 or 403.
//
// SECURITY: an email reaches real people and cannot be recalled; its text is chosen by the caller (a model must be told to ask a human first).
// Retries: SendGrid has no idempotency key for /mail/send, so a send is never retried by this kit; check before sending again.

const id = z.string().min(1)
const address = z.string().email().max(320)
const addresses = z.array(address).min(1).max(1000)
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(200).optional() }
const template = z.looseObject({ id: z.string(), name: z.string().optional(), generation: z.string().optional(), updated_at: z.string().optional(), versions: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), active: z.number().optional(), subject: z.string().optional() })).optional() })
const bounce = z.looseObject({ email: z.string(), created: z.number().optional(), reason: z.string().optional(), status: z.string().optional() })
const metrics = z.looseObject({ requests: z.number().optional(), delivered: z.number().optional(), opens: z.number().optional(), clicks: z.number().optional(), bounces: z.number().optional(), spam_reports: z.number().optional(), unsubscribes: z.number().optional() })

export const sendgrid = defineConnector({
  name: "sendgrid",
  baseUrl: "https://api.sendgrid.com/v3",
  auth: { type: "bearer" },
  meta: {
    title: "SendGrid",
    description: "Send email with Twilio SendGrid, list email templates, read bounces, and see delivery statistics.",
    docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference",
    status: "docs-based",
    credentialEnv: "SENDGRID_API_KEY",
  },
  actions: {
    "mail.send": {
      description: "Send an email to up to 1000 recipients. This reaches real people and cannot be recalled: ask a human first. Give text, html or both. Nothing is retried automatically, so check delivery before sending again.",
      method: "POST",
      path: "/mail/send",
      input: z
        .object({
          from: address,
          fromName: z.string().max(200).optional(),
          to: addresses,
          cc: addresses.optional(),
          bcc: addresses.optional(),
          subject: z.string().min(1).max(998),
          text: z.string().optional(),
          html: z.string().optional(),
          replyTo: address.optional(),
          categories: z.array(z.string().max(255)).max(10).optional().describe("Labels to group this message in statistics"),
        })
        .refine((i) => i.text !== undefined || i.html !== undefined, { message: "Give text, html or both" }),
      output: z.unknown(),
      effect: "write",
      buildBody: (i) => {
        const list = (v: unknown) => (v as string[]).map((email) => ({ email }))
        return {
          personalizations: [{ to: list(i.to), ...(i.cc !== undefined && { cc: list(i.cc) }), ...(i.bcc !== undefined && { bcc: list(i.bcc) }) }],
          from: { email: i.from, ...(i.fromName !== undefined && { name: i.fromName }) },
          subject: i.subject,
          // SendGrid requires text/plain to come before text/html.
          content: [...(i.text !== undefined ? [{ type: "text/plain", value: i.text }] : []), ...(i.html !== undefined ? [{ type: "text/html", value: i.html }] : [])],
          ...(i.replyTo !== undefined && { reply_to: { email: i.replyTo } }),
          ...(i.categories !== undefined && { categories: i.categories }),
        }
      },
    },
    "templates.list": {
      description: "List dynamic email templates with their versions. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/templates",
      input: z.object({ ...paging }),
      output: z.array(template),
      effect: "read",
      paginate: bodyLinkPagination({ itemsKey: "result", nextUrlPath: ["_metadata", "next"], pageSizeParam: "page_size", defaultPageSize: 25, maxPageSize: 200 }),
      buildQuery: () => ({ generations: "dynamic" }),
    },
    "template.get": {
      description: "Get one template by id, with its versions.",
      method: "GET",
      path: "/templates/{templateId}",
      input: z.object({ templateId: id }),
      output: template,
      effect: "read",
    },
    "bounces.list": {
      description: "List email addresses whose mail bounced (newest first), with the reason. Use limit and offset to move through the list; times are Unix seconds.",
      method: "GET",
      path: "/suppression/bounces",
      input: z.object({
        email: address.optional().describe("Only this address"),
        startTime: z.number().int().optional().describe("Only bounces after this Unix time"),
        endTime: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      output: z.array(bounce),
      effect: "read",
      buildQuery: (i) => ({ limit: i.limit, offset: i.offset, ...(i.email !== undefined && { email: i.email }), ...(i.startTime !== undefined && { start_time: i.startTime }), ...(i.endTime !== undefined && { end_time: i.endTime }) }),
    },
    "stats.get": {
      description: "Get global email statistics (requests, delivered, opens, clicks, bounces, spam reports) between two dates, by day, week or month.",
      method: "GET",
      path: "/stats",
      input: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional(),
        aggregatedBy: z.enum(["day", "week", "month"]).optional(),
      }),
      output: z.array(z.looseObject({ date: z.string(), stats: z.array(z.looseObject({ metrics: metrics.optional() })).optional() })),
      effect: "read",
      buildQuery: (i) => ({ start_date: i.startDate, ...(i.endDate !== undefined && { end_date: i.endDate }), ...(i.aggregatedBy !== undefined && { aggregated_by: i.aggregatedBy }) }),
    },
    "user.profile": {
      description: "Get the account profile that owns the API key. Use it to check a new connection.",
      method: "GET",
      path: "/user/profile",
      input: z.object({}),
      output: z.looseObject({ first_name: z.string().optional(), last_name: z.string().optional(), company: z.string().optional() }),
      effect: "read",
    },
  },
})

export default sendgrid
