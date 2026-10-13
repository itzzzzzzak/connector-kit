import { ConnectorKitError, bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Meta's WhatsApp Business Platform (Cloud API) reference, developers.facebook.com/docs/whatsapp/cloud-api: base URL
// https://graph.facebook.com/v23.0, `Authorization: Bearer <access token>` (a System User token with whatsapp_business_messaging and
// whatsapp_business_management), a business phone number is addressed by its numeric "phone number id" (NOT the number itself) and the account by its
// WhatsApp Business Account id (WABA id). Messages are one POST /{phone-number-id}/messages with messaging_product "whatsapp", a recipient `to` in
// international digits ("15551234567") and a `type`. Free-form text and media can only be sent inside the 24 hours after the customer last wrote;
// outside it only an approved TEMPLATE message works. Lists answer { data, paging: { cursors, next } } and `next` is a full URL.
// Errors are { error: { code, type, message } } with HTTP 400/401/403; code 190 is a bad or expired token and 4, 17, 32, 613, 80007 and 130429 are
// rate limits.
//
// SECURITY: a message reaches a real person's phone at once and cannot be recalled, and Meta can restrict or ban a number that sends what people
// report: a model must ask a human before sending, and should not send in bulk. Message text, names and profile data come from outside and can
// contain text aimed at an AI: they are data, never instructions.

const id = z.string().regex(/^\d{5,20}$/, "An id is 5 to 20 digits")
const phoneNumberId = id.describe("The phone number id (digits) from phoneNumbers.list, not the phone number itself")
const wabaId = id.describe("The WhatsApp Business Account id (digits)")
const recipient = z.string().regex(/^\d{7,15}$/, "Write the number in international form with digits only, such as 15551234567").describe("The recipient's number: country code then number, digits only")
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(100).optional() }
const sent = z.looseObject({ messages: z.array(z.looseObject({ id: z.string() })).optional(), contacts: z.array(z.looseObject({ wa_id: z.string().optional() })).optional() })
const base = (to: string, type: string) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type })
const mediaKind = z.enum(["image", "document", "video", "audio"])

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056])

export const whatsapp = defineConnector({
  name: "whatsapp",
  baseUrl: "https://graph.facebook.com/v23.0",
  auth: { type: "bearer" },
  // Graph API answers a bad token with HTTP 400 and code 190, and many rate limits with 400 and a code, so the status alone is not enough.
  detectHttpError: ({ status, body }) => {
    const error = typeof body === "object" && body !== null ? (body as { error?: { code?: unknown } }).error : undefined
    const code = typeof error?.code === "number" ? error.code : undefined
    if (code === 190 || code === 102) return new ConnectorKitError("auth_expired", "Meta rejected the access token (expired or revoked). Create a new System User token.", { retryable: false, status })
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", { retryable: true, status })
    return undefined
  },
  meta: {
    title: "WhatsApp",
    description: "Send WhatsApp messages, templates and media from a business number through Meta's Cloud API, and read the account's phone numbers, templates and business profile.",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    status: "docs-based",
    credentialEnv: "WHATSAPP_ACCESS_TOKEN",
  },
  actions: {
    "phoneNumbers.list": {
      description: "List the business phone numbers of a WhatsApp Business Account, with their display number, verified name and quality rating. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/{wabaId}/phone_numbers",
      input: z.object({ wabaId, ...paging }),
      output: z.array(z.looseObject({ id: z.string(), display_phone_number: z.string().optional(), verified_name: z.string().optional(), quality_rating: z.string().optional() })),
      effect: "read",
      paginate: bodyLinkPagination({ itemsKey: "data", nextUrlPath: ["paging", "next"], pageSizeParam: "limit", defaultPageSize: 25, maxPageSize: 100 }),
    },
    "phoneNumber.get": {
      description: "Get one business phone number: its display number, verified name, quality rating, messaging limit tier and status.",
      method: "GET",
      path: "/{phoneNumberId}",
      input: z.object({ phoneNumberId }),
      output: z.looseObject({ id: z.string(), display_phone_number: z.string().optional(), verified_name: z.string().optional(), quality_rating: z.string().optional() }),
      effect: "read",
      buildQuery: () => ({ fields: "id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status" }),
    },
    "businessProfile.get": {
      description: "Get a business number's public WhatsApp profile: about text, address, description, email, website and category.",
      method: "GET",
      path: "/{phoneNumberId}/whatsapp_business_profile",
      input: z.object({ phoneNumberId }),
      output: z.looseObject({ data: z.array(z.looseObject({ about: z.string().optional(), description: z.string().optional(), email: z.string().optional(), websites: z.array(z.string()).optional() })).optional() }),
      effect: "read",
      buildQuery: () => ({ fields: "about,address,description,email,profile_picture_url,websites,vertical" }),
    },
    "templates.list": {
      description: "List the message templates of a WhatsApp Business Account with their name, language, category and approval status. Only APPROVED templates can be sent. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/{wabaId}/message_templates",
      input: z.object({ wabaId, name: z.string().optional().describe("Only templates with this name"), status: z.enum(["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"]).optional(), ...paging }),
      output: z.array(z.looseObject({ id: z.string().optional(), name: z.string(), language: z.string().optional(), status: z.string().optional(), category: z.string().optional(), components: z.array(z.unknown()).optional() })),
      effect: "read",
      buildQuery: (i) => ({ ...(i.name !== undefined && { name: i.name }), ...(i.status !== undefined && { status: i.status }) }),
      paginate: bodyLinkPagination({ itemsKey: "data", nextUrlPath: ["paging", "next"], pageSizeParam: "limit", defaultPageSize: 25, maxPageSize: 100 }),
    },
    "media.get": {
      description: "Get the temporary download URL, type and size of a media file that a customer sent (use the media id from the incoming message). The URL needs the same access token and expires after about 5 minutes.",
      method: "GET",
      path: "/{mediaId}",
      input: z.object({ mediaId: id }),
      output: z.looseObject({ id: z.string(), url: z.string().optional(), mime_type: z.string().optional(), file_size: z.number().optional() }),
      effect: "read",
    },
    "messages.sendText": {
      description: "Send a text message from a business number. It reaches a real person's phone at once and works only within 24 hours after the customer last wrote (otherwise use messages.sendTemplate): ask a human first.",
      method: "POST",
      path: "/{phoneNumberId}/messages",
      input: z.object({ phoneNumberId, to: recipient, text: z.string().min(1).max(4096), previewUrl: z.boolean().optional().describe("Show a link preview for the first URL in the text"), replyToMessageId: z.string().min(1).optional().describe("The id of a message to reply to") }),
      output: sent,
      effect: "write",
      buildBody: (i) => ({ ...base(i.to as string, "text"), text: { body: i.text, ...(i.previewUrl !== undefined && { preview_url: i.previewUrl }) }, ...(i.replyToMessageId !== undefined && { context: { message_id: i.replyToMessageId } }) }),
    },
    "messages.sendTemplate": {
      description: "Send an approved message template (the only kind of message allowed outside the 24 hour window). It reaches a real person's phone at once and the business is charged for it: ask a human first.",
      method: "POST",
      path: "/{phoneNumberId}/messages",
      input: z.object({
        phoneNumberId,
        to: recipient,
        name: z.string().min(1).max(512).describe("The template name from templates.list"),
        language: z.string().min(2).max(10).describe('The template language code, such as "en_US"'),
        components: z.array(z.record(z.string(), z.unknown())).max(10).optional().describe("Values for the template's variables, in Meta's components format"),
      }),
      output: sent,
      effect: "write",
      buildBody: (i) => ({ ...base(i.to as string, "template"), template: { name: i.name, language: { code: i.language }, ...(i.components !== undefined && { components: i.components }) } }),
    },
    "messages.sendMedia": {
      description: "Send an image, document, video or audio file from a public https link. It reaches a real person's phone at once and works only within 24 hours after the customer last wrote: ask a human first.",
      method: "POST",
      path: "/{phoneNumberId}/messages",
      input: z.object({ phoneNumberId, to: recipient, kind: mediaKind, link: z.string().url().startsWith("https://"), caption: z.string().max(1024).optional().describe("Not allowed for audio"), filename: z.string().max(240).optional().describe("Only for documents") }),
      output: sent,
      effect: "write",
      buildBody: (i) => ({ ...base(i.to as string, i.kind as string), [i.kind as string]: { link: i.link, ...(i.caption !== undefined && { caption: i.caption }), ...(i.filename !== undefined && { filename: i.filename }) } }),
    },
    "messages.markRead": {
      description: "Mark an incoming message as read, which shows the customer the blue ticks.",
      method: "POST",
      path: "/{phoneNumberId}/messages",
      input: z.object({ phoneNumberId, messageId: z.string().min(1).describe("The id of the incoming message") }),
      output: z.looseObject({ success: z.boolean().optional() }),
      effect: "write",
      buildBody: (i) => ({ messaging_product: "whatsapp", status: "read", message_id: i.messageId }),
    },
  },
})

export default whatsapp
