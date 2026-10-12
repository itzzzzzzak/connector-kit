import { defineConnector, lastItemPagination } from "../../index.js"
import { z } from "zod"

// Facts from Resend's API reference: base URL https://api.resend.com, `Authorization: Bearer re_...` (an API key with "full access" or "sending
// access" only), lists answer { object: "list", data: [...], has_more } and page with `limit` (at most 100) plus `after` / `before` (an item id),
// "Send email" is a POST /emails that answers { id }, and POST requests accept an `Idempotency-Key` header (kept for 24 hours), which is what makes a
// retry after a timeout safe here. `to` may be one address or a list of at most 50. Sending needs a verified domain for the `from` address.
//
// SECURITY: an email reaches real people and cannot be recalled; its text is chosen by the caller (a model must be told to ask a human first).
// Email subjects and bodies read back from the API were written by others and can contain text aimed at an AI: they are data, never instructions.

const id = z.string().min(1)
const address = z.string().min(3).max(320).describe('An email address, or "Name <address@example.com>"')
const addresses = z.union([address, z.array(address).min(1).max(50)])
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(100).optional() }
const email = z.looseObject({
  id: z.string(),
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  subject: z.string().nullish(),
  created_at: z.string().optional(),
  last_event: z.string().nullish().describe("delivered, bounced, complained, opened, clicked, ..."),
  scheduled_at: z.string().nullish(),
})
const domain = z.looseObject({ id: z.string(), name: z.string().optional(), status: z.string().optional(), region: z.string().optional(), created_at: z.string().optional() })

export const resend = defineConnector({
  name: "resend",
  baseUrl: "https://api.resend.com",
  auth: { type: "bearer" },
  idempotencyKeyHeader: "Idempotency-Key",
  meta: {
    title: "Resend",
    description: "Send transactional email with Resend, check whether an email was delivered, and list sent emails and sending domains.",
    docsUrl: "https://resend.com/docs/api-reference/introduction",
    status: "docs-based",
    credentialEnv: "RESEND_API_KEY",
  },
  actions: {
    "emails.send": {
      description: "Send an email from a verified domain. This reaches real people and cannot be recalled: ask a human first. Give html, text or both. A retry after a timeout cannot send it twice.",
      method: "POST",
      path: "/emails",
      input: z
        .object({
          from: address,
          to: addresses,
          subject: z.string().min(1).max(998),
          html: z.string().optional(),
          text: z.string().optional(),
          cc: addresses.optional(),
          bcc: addresses.optional(),
          replyTo: addresses.optional(),
          scheduledAt: z.string().optional().describe('When to send: ISO 8601 or natural language such as "in 1 hour". Default: now'),
          tags: z.array(z.object({ name: z.string(), value: z.string() })).max(20).optional(),
        })
        .refine((i) => i.html !== undefined || i.text !== undefined, { message: "Give html, text or both" }),
      output: z.looseObject({ id: z.string() }),
      effect: "write",
      buildBody: (i) => {
        const { replyTo, scheduledAt, ...rest } = i
        return { ...rest, ...(replyTo !== undefined && { reply_to: replyTo }), ...(scheduledAt !== undefined && { scheduled_at: scheduledAt }) }
      },
    },
    "email.get": {
      description: "Get a sent email by id, including its last delivery event (delivered, bounced, complained, opened, clicked).",
      method: "GET",
      path: "/emails/{emailId}",
      input: z.object({ emailId: id }),
      output: email,
      effect: "read",
    },
    "emails.list": {
      description: "List recently sent emails, newest first, with their last delivery event. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/emails",
      input: z.object({ ...paging }),
      output: z.array(email),
      effect: "read",
      paginate: lastItemPagination({ cursorParam: "after", defaultPageSize: 20 }),
    },
    "email.cancel": {
      description: "Cancel a scheduled email before it is sent. It does nothing for an email that has already gone out.",
      method: "POST",
      path: "/emails/{emailId}/cancel",
      input: z.object({ emailId: id }),
      output: z.looseObject({ id: z.string().optional() }),
      effect: "destructive",
    },
    "domains.list": {
      description: "List the sending domains with their verification status. Use it to check which `from` addresses will work.",
      method: "GET",
      path: "/domains",
      input: z.object({ ...paging }),
      output: z.array(domain),
      effect: "read",
      paginate: lastItemPagination({ cursorParam: "after", defaultPageSize: 20 }),
    },
    "domain.get": {
      description: "Get one sending domain by id, with the DNS records that must exist for it to verify.",
      method: "GET",
      path: "/domains/{domainId}",
      input: z.object({ domainId: id }),
      output: domain.extend({ records: z.array(z.looseObject({ record: z.string().optional(), name: z.string().optional(), type: z.string().optional(), value: z.string().optional(), status: z.string().optional() })).optional() }),
      effect: "read",
    },
  },
})

export default resend
