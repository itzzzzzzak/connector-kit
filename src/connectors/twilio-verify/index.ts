import { bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Twilio's Verify v2 reference and the OpenAPI description Twilio publishes (github.com/twilio/twilio-oai, MIT): base URL
// https://verify.twilio.com, paths like /v2/Services/{ServiceSid}/Verifications, HTTP Basic auth ("<AccountSid>:<AuthToken>" or an API Key SID
// and secret), form-encoded bodies, snake_case JSON. A Verify SERVICE (VA...) holds the settings (code length, channels); you start a
// verification for a phone number or email, the person receives a code, and you check the code they type back. Lists page with `PageSize` and
// an absolute `meta.next_page_url`. A code is valid for 10 minutes and a verification allows 5 check attempts.
//
// A curated, typed set is written by hand (the one-time-code flow); the rest (57 calls: factors, challenges, rate limits, templates, ...) is
// generated from Twilio's description (ADR-018) and untyped on the way out.
// SECURITY: starting a verification sends a text, call or email to a real person and costs money, and public sign-up forms that trigger it
// are a known target for SMS pumping fraud: rate limit callers, and ask a human before an agent starts verifications in bulk. Never log or
// show the code a user types. A check answers "approved" only for the right code.

const serviceSid = z.string().regex(/^VA[0-9a-fA-F]{32}$/, "A Verify Service SID: VA followed by 32 hex characters").describe("The Verify Service SID (VA...)")
const to = z.string().min(3).max(320).describe("A phone number in E.164 format (+14155552671) or an email address")
const verification = z.looseObject({
  sid: z.string(),
  service_sid: z.string().optional(),
  to: z.string().optional(),
  channel: z.string().optional(),
  status: z.string().optional().describe("pending, approved, canceled, max_attempts_reached, deleted, failed, expired"),
  valid: z.boolean().optional(),
  date_created: z.string().nullish(),
  date_updated: z.string().nullish(),
})
const service = z.looseObject({ sid: z.string(), friendly_name: z.string().optional(), code_length: z.number().optional(), date_created: z.string().nullish() })

export const twilioVerify = defineConnector({
  name: "twilio-verify",
  baseUrl: "https://verify.twilio.com",
  auth: { type: "basic" },
  bodyFormat: "form-repeat",
  meta: {
    title: "Twilio Verify",
    description: "Verify phone numbers and emails with one-time codes over SMS, voice, WhatsApp or email: start a verification, check the code, and manage Verify services.",
    docsUrl: "https://www.twilio.com/docs/verify/api",
    status: "docs-based",
    credentialEnv: "TWILIO_CREDENTIALS",
  },
  actions: {
    ...generatedActions,
    "services.list": {
      description: "List the Verify services in the account (each has its own code length and channel settings). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/v2/Services",
      input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(service),
      effect: "read",
      paginate: bodyLinkPagination({ itemsKey: "services", nextUrlPath: ["meta", "next_page_url"], pageSizeParam: "PageSize", defaultPageSize: 50, maxPageSize: 1000 }),
    },
    "verifications.start": {
      description: "Send a one-time code to a phone number or email. Channel is sms, call, whatsapp, email or sna. Costs money and contacts a real person.",
      method: "POST",
      path: "/v2/Services/{ServiceSid}/Verifications",
      input: z.object({ ServiceSid: serviceSid, To: to, Channel: z.enum(["sms", "call", "whatsapp", "email", "sna"]), Locale: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, "e.g. en or pt-BR").optional(), CustomFriendlyName: z.string().max(60).optional().describe("The name shown in the message in place of the service's") }),
      output: verification,
      effect: "write",
    },
    "verifications.check": {
      description: "Check the code a person typed against the verification started for To (or for a VerificationSid). status approved and valid true mean the code was right.",
      method: "POST",
      path: "/v2/Services/{ServiceSid}/VerificationCheck",
      input: z.object({ ServiceSid: serviceSid, To: to.optional(), VerificationSid: z.string().regex(/^VE[0-9a-fA-F]{32}$/).optional(), Code: z.string().regex(/^[0-9A-Za-z]{4,10}$/, "The code, 4 to 10 characters") }).refine((i) => (i.To === undefined) !== (i.VerificationSid === undefined), "Give exactly one of To or VerificationSid"),
      output: verification,
      effect: "write",
    },
    "verifications.get": {
      description: "Get a verification by SID or by the number/email it was sent to: its status and channel.",
      method: "GET",
      path: "/v2/Services/{ServiceSid}/Verifications/{Sid}",
      input: z.object({ ServiceSid: serviceSid, Sid: z.string().min(3).max(320).describe("The verification SID (VE...), or the phone number / email it was sent to") }),
      output: verification,
      effect: "read",
    },
    "verifications.cancel": {
      description: "Cancel a pending verification so its code can no longer be approved (Status canceled).",
      method: "POST",
      path: "/v2/Services/{ServiceSid}/Verifications/{Sid}",
      input: z.object({ ServiceSid: serviceSid, Sid: z.string().regex(/^VE[0-9a-fA-F]{32}$/), Status: z.literal("canceled").default("canceled") }),
      output: verification,
      effect: "write",
    },
  },
})

export default twilioVerify
