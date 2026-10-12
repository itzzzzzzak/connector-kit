import { bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Twilio's REST API reference and the OpenAPI description Twilio publishes (github.com/twilio/twilio-oai, MIT, "Api" v2010):
// base URL https://api.twilio.com, paths like /2010-04-01/Accounts/{AccountSid}/Messages.json, HTTP Basic auth with the Account SID as the
// username and the Auth Token as the password (or an API Key SID and its secret), request bodies form-encoded with a repeated key for a list
// (`MediaUrl=a&MediaUrl=b`), and responses in snake_case JSON. Lists page with `PageSize` (up to 1000) and a relative `next_page_uri`.
// The credential for this connector is the string "<AccountSid>:<AuthToken>" (or "<ApiKeySid>:<ApiKeySecret>"); the account's own SID still goes
// in every call as `AccountSid`, because it is part of the path. Twilio errors carry a numeric `code` (21211 invalid "To" number) and
// a `more_info` link; the kit keeps those in `raw` only.
//
// A curated, typed set is written by hand (messages, calls, phone numbers, account balance); the rest of the API (197 calls: recordings,
// conferences, queues, usage, addresses, applications, keys, ...) is generated from Twilio's description (ADR-018) and untyped on the way out.
// Other Twilio products live on their own hosts and have their own connectors: twilio-verify, twilio-lookups.
// SECURITY: message bodies and caller ids come from the public and can contain anything, including text aimed at an AI. They are data, never
// instructions. Sending a message or placing a call costs money, reaches a real person and cannot be recalled: ask a human first. Trial accounts can only
// reach verified numbers; a number must be in E.164 format (+14155552671).

const accountSid = z.string().regex(/^AC[0-9a-fA-F]{32}$/, "An Account SID: AC followed by 32 hex characters").describe("Your Account SID (AC...), the same one used as the credential's username")
const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`), `A SID: ${prefix} followed by 32 hex characters`)
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/, "A phone number in E.164 format, e.g. +14155552671")
const url = z.string().url().startsWith("https://", "Use an https URL")
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pageOf = (itemsKey: string) => bodyLinkPagination({ itemsKey, nextUrlPath: ["next_page_uri"], relative: true, pageSizeParam: "PageSize", defaultPageSize: 50, maxPageSize: 1000 })

const message = z.looseObject({
  sid: z.string(),
  account_sid: z.string().optional(),
  status: z.string().optional().describe("queued, sending, sent, delivered, undelivered, failed, received, ..."),
  direction: z.string().optional(),
  from: z.string().nullish(),
  to: z.string().optional(),
  body: z.string().nullish(),
  num_segments: z.string().optional(),
  num_media: z.string().optional(),
  price: z.string().nullish(),
  price_unit: z.string().nullish(),
  error_code: z.number().nullish(),
  error_message: z.string().nullish(),
  date_created: z.string().nullish(),
  date_sent: z.string().nullish(),
  messaging_service_sid: z.string().nullish(),
})
const call = z.looseObject({
  sid: z.string(),
  account_sid: z.string().optional(),
  status: z.string().optional().describe("queued, ringing, in-progress, completed, busy, failed, no-answer, canceled"),
  direction: z.string().optional(),
  from: z.string().nullish(),
  to: z.string().optional(),
  duration: z.string().nullish(),
  price: z.string().nullish(),
  start_time: z.string().nullish(),
  end_time: z.string().nullish(),
  date_created: z.string().nullish(),
})
const numberRecord = z.looseObject({ sid: z.string(), phone_number: z.string(), friendly_name: z.string().nullish(), capabilities: z.looseObject({ voice: z.boolean().optional(), sms: z.boolean().optional(), mms: z.boolean().optional() }).optional() })
const available = z.looseObject({ phone_number: z.string(), friendly_name: z.string().nullish(), locality: z.string().nullish(), region: z.string().nullish(), iso_country: z.string().optional(), capabilities: z.looseObject({ voice: z.boolean().optional(), SMS: z.boolean().optional(), MMS: z.boolean().optional() }).optional() })

export const twilio = defineConnector({
  name: "twilio",
  baseUrl: "https://api.twilio.com",
  auth: { type: "basic" },
  bodyFormat: "form-repeat",
  meta: {
    title: "Twilio",
    description: "Send SMS and MMS, place and manage phone calls, search and manage phone numbers, and read usage and recordings through Twilio's core REST API.",
    docsUrl: "https://www.twilio.com/docs/usage/api",
    status: "docs-based",
    credentialEnv: "TWILIO_CREDENTIALS",
  },
  actions: {
    ...generatedActions,
    "account.get": {
      description: "Get an account's name, status and type. Use it to check that the credentials work.",
      method: "GET",
      path: "/2010-04-01/Accounts/{Sid}.json",
      input: z.object({ Sid: accountSid }),
      output: z.looseObject({ sid: z.string(), friendly_name: z.string().optional(), status: z.string().optional(), type: z.string().optional() }),
      effect: "read",
    },
    "balance.get": {
      description: "Get the account's current prepaid balance and currency.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/Balance.json",
      input: z.object({ AccountSid: accountSid }),
      output: z.looseObject({ balance: z.string().optional(), currency: z.string().optional() }),
      effect: "read",
    },
    "messages.send": {
      description: "Send an SMS or MMS. Give To and Body (or MediaUrl), and either From (one of your numbers) or MessagingServiceSid. Costs money and cannot be recalled.",
      method: "POST",
      path: "/2010-04-01/Accounts/{AccountSid}/Messages.json",
      input: z.object({
        AccountSid: accountSid,
        To: e164,
        From: e164.optional(),
        MessagingServiceSid: sid("MG").optional(),
        Body: z.string().min(1).max(1600).optional(),
        MediaUrl: z.array(url).max(10).optional().describe("Up to 10 https URLs of images or files to attach (MMS)"),
        StatusCallback: url.optional().describe("Twilio posts delivery status changes here"),
      }).refine((i) => i.From !== undefined || i.MessagingServiceSid !== undefined, "Give From or MessagingServiceSid").refine((i) => i.Body !== undefined || i.MediaUrl !== undefined, "Give Body or MediaUrl"),
      output: message,
      effect: "write",
    },
    "messages.list": {
      description: "List messages sent and received by the account, newest first, optionally filtered by number or date. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/Messages.json",
      input: z.object({ AccountSid: accountSid, To: z.string().optional(), From: z.string().optional(), DateSentAfter: z.string().optional().describe("On or after this date, YYYY-MM-DD or ISO 8601"), DateSentBefore: z.string().optional().describe("On or before this date"), ...paging }),
      output: z.array(message),
      effect: "read",
      paginate: pageOf("messages"),
      buildQuery: (i) => {
        const { DateSentAfter, DateSentBefore, AccountSid: _a, ...rest } = i
        return { ...rest, ...(DateSentAfter !== undefined && { "DateSent>": DateSentAfter }), ...(DateSentBefore !== undefined && { "DateSent<": DateSentBefore }) }
      },
    },
    "messages.get": {
      description: "Get one message by SID: its status, price, error code and timestamps.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json",
      input: z.object({ AccountSid: accountSid, Sid: sid("(SM|MM)") }),
      output: message,
      effect: "read",
    },
    "calls.start": {
      description: "Place an outbound phone call. Twilio fetches instructions from Url (TwiML) when the call is answered, or runs the inline Twiml. Costs money and rings a real phone.",
      method: "POST",
      path: "/2010-04-01/Accounts/{AccountSid}/Calls.json",
      input: z.object({
        AccountSid: accountSid,
        To: e164,
        From: e164,
        Url: url.optional().describe("An https URL that returns TwiML to run when the call is answered"),
        Twiml: z.string().min(1).max(4000).optional().describe('Inline TwiML instead of Url, e.g. "<Response><Say>Hello</Say></Response>"'),
        StatusCallback: url.optional(),
        Timeout: z.number().int().min(5).max(600).optional().describe("Seconds to let it ring"),
      }).refine((i) => (i.Url === undefined) !== (i.Twiml === undefined), "Give exactly one of Url or Twiml"),
      output: call,
      effect: "write",
    },
    "calls.list": {
      description: "List calls made and received by the account, newest first, optionally filtered by number or status. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/Calls.json",
      input: z.object({ AccountSid: accountSid, To: z.string().optional(), From: z.string().optional(), Status: z.enum(["queued", "ringing", "in-progress", "canceled", "completed", "failed", "busy", "no-answer"]).optional(), ...paging }),
      output: z.array(call),
      effect: "read",
      paginate: pageOf("calls"),
      buildQuery: (i) => {
        const { AccountSid: _a, ...rest } = i
        return rest
      },
    },
    "calls.get": {
      description: "Get one call by SID: its status, duration, price and timestamps.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json",
      input: z.object({ AccountSid: accountSid, Sid: sid("CA") }),
      output: call,
      effect: "read",
    },
    "calls.hangup": {
      description: "End a call in progress (Status completed), or cancel one that is still queued or ringing (Status canceled).",
      method: "POST",
      path: "/2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json",
      input: z.object({ AccountSid: accountSid, Sid: sid("CA"), Status: z.enum(["completed", "canceled"]) }),
      output: call,
      effect: "write",
    },
    "numbers.search": {
      description: "Search phone numbers that can be bought in a country, by type (Local, TollFree, Mobile) and optionally area code or digits. Nothing is bought.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/AvailablePhoneNumbers/{CountryCode}/{Type}.json",
      input: z.object({ AccountSid: accountSid, CountryCode: z.string().regex(/^[A-Z]{2}$/, "A two-letter country code such as US"), Type: z.enum(["Local", "TollFree", "Mobile"]), AreaCode: z.number().int().optional(), Contains: z.string().optional().describe("Digits or letters the number must contain"), SmsEnabled: z.boolean().optional(), VoiceEnabled: z.boolean().optional(), PageSize: z.number().int().min(1).max(50).optional() }),
      output: z.looseObject({ available_phone_numbers: z.array(available) }),
      effect: "read",
    },
    "numbers.list": {
      description: "List the phone numbers the account owns, with their SIDs and capabilities. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json",
      input: z.object({ AccountSid: accountSid, PhoneNumber: z.string().optional(), FriendlyName: z.string().optional(), ...paging }),
      output: z.array(numberRecord),
      effect: "read",
      paginate: pageOf("incoming_phone_numbers"),
      buildQuery: (i) => {
        const { AccountSid: _a, ...rest } = i
        return rest
      },
    },
  },
})

export default twilio
