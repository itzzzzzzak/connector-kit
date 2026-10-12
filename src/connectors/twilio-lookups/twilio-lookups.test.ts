import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import lookups from "./index.js"

const connect = { credentials: { token: "AC" + "c".repeat(32) + ":token" } }
const found = { phone_number: "+14155552671", valid: true, validation_errors: null, calling_country_code: "1", country_code: "US", national_format: "(415) 555-2671", line_type_intelligence: { type: "mobile", carrier_name: "Acme Wireless" } }

standardTests(lookups, { action: "phoneNumbers.lookup", input: { PhoneNumber: "+14155552671" }, ok: found, badInput: { PhoneNumber: "+14155552671", Fields: "Line Type!" }, connect })

test("a lookup puts the number in the path and the data packages in the query", async () => {
  const { conn, calls } = harness(lookups, () => json(found), connect)
  await conn.execute("phoneNumbers.lookup", { PhoneNumber: "+14155552671", Fields: "line_type_intelligence,sms_pumping_risk" })
  assert.equal(calls[0]!.url.pathname, "/v2/PhoneNumbers/%2B14155552671")
  assert.equal(calls[0]!.url.searchParams.get("Fields"), "line_type_intelligence,sms_pumping_risk")
  await conn.execute("phoneNumbers.lookup", { PhoneNumber: "415 555 2671", CountryCode: "US" })
  assert.equal(calls[1]!.url.searchParams.get("CountryCode"), "US")
})

test("the only mutating calls are the generated ones, and deletes are destructive", () => {
  const actions = lookups.actions as Record<string, { effect: string; method: string }>
  for (const [name, action] of Object.entries(actions)) if (action.method === "DELETE") assert.equal(action.effect, "destructive", name)
})
