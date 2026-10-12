import { defineConnector } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Twilio's Lookup v2 reference and the OpenAPI description Twilio publishes (github.com/twilio/twilio-oai, MIT): base URL
// https://lookups.twilio.com, `GET /v2/PhoneNumbers/{PhoneNumber}` validates and formats a number for free, and `Fields` (comma-separated)
// adds paid data packages: line_type_intelligence, sms_pumping_risk, caller_name, sim_swap, call_forwarding, identity_match, ... Basic auth
// with "<AccountSid>:<AuthToken>" (or an API key). A number may be national ("415 555 2671", with CountryCode) or E.164 (+14155552671).
// The one curated action covers the lookup; the rest (9 calls: bulk lookups, rate limits, overrides) is generated and untyped (ADR-018).
// SECURITY: the data describes a real person's phone. Treat it as personal data; paid fields cost per lookup.

export const twilioLookups = defineConnector({
  name: "twilio-lookups",
  baseUrl: "https://lookups.twilio.com",
  auth: { type: "basic" },
  bodyFormat: "form-repeat",
  meta: {
    title: "Twilio Lookups",
    description: "Validate and format phone numbers and look up line type, carrier and fraud-risk data for them with Twilio Lookup.",
    docsUrl: "https://www.twilio.com/docs/lookup/v2-api",
    status: "docs-based",
    credentialEnv: "TWILIO_CREDENTIALS",
  },
  actions: {
    ...generatedActions,
    "phoneNumbers.lookup": {
      description: "Validate a phone number and get its formatted forms and country. Add Fields (e.g. line_type_intelligence, sms_pumping_risk) for paid data packages.",
      method: "GET",
      path: "/v2/PhoneNumbers/{PhoneNumber}",
      input: z.object({
        PhoneNumber: z.string().min(3).max(32).describe("E.164 (+14155552671), or national format together with CountryCode"),
        CountryCode: z.string().regex(/^[A-Z]{2}$/, "A two-letter country code such as US").optional(),
        Fields: z.string().regex(/^[a-z_]+(,[a-z_]+)*$/, "Comma-separated package names, e.g. line_type_intelligence,sms_pumping_risk").optional().describe("Paid data packages, comma-separated"),
      }),
      output: z.looseObject({
        phone_number: z.string().optional(),
        valid: z.boolean().optional(),
        validation_errors: z.array(z.string()).nullish(),
        calling_country_code: z.string().nullish(),
        country_code: z.string().nullish(),
        national_format: z.string().nullish(),
        line_type_intelligence: z.looseObject({ type: z.string().nullish(), carrier_name: z.string().nullish() }).nullish(),
        sms_pumping_risk: z.looseObject({ sms_pumping_risk_score: z.number().nullish(), carrier_risk_category: z.string().nullish() }).nullish(),
      }),
      effect: "read",
    },
  },
})

export default twilioLookups
