import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import verify from "./index.js"

const VA = "VA" + "a".repeat(32)
const VE = "VE" + "b".repeat(32)
const connect = { credentials: { token: "AC" + "c".repeat(32) + ":token" } }
const verification = { sid: VE, service_sid: VA, to: "+14155552671", channel: "sms", status: "pending", valid: false }
const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(verify, { ...c, connect })

std({ action: "services.list", input: {}, ok: { services: [{ sid: VA, friendly_name: "Acme", code_length: 6 }], meta: { next_page_url: null, key: "services" } }, badInput: { pageSize: "x" } })
std({ action: "verifications.start", input: { ServiceSid: VA, To: "+14155552671", Channel: "sms" }, ok: verification, badInput: { ServiceSid: VA, To: "+14155552671", Channel: "pigeon" } })
std({ action: "verifications.check", input: { ServiceSid: VA, To: "+14155552671", Code: "123456" }, ok: { ...verification, status: "approved", valid: true }, badInput: { ServiceSid: VA, To: "+14155552671", Code: "12" } })
std({ action: "verifications.get", input: { ServiceSid: VA, Sid: VE }, ok: verification, badInput: { ServiceSid: "VA1", Sid: VE } })
std({ action: "verifications.cancel", input: { ServiceSid: VA, Sid: VE }, ok: { ...verification, status: "canceled" }, badInput: { ServiceSid: VA, Sid: "x" } })

test("starting a verification posts To and Channel as a form to the service", async () => {
  const { conn, calls } = harness(verify, () => json(verification, 201), connect)
  await conn.execute("verifications.start", { ServiceSid: VA, To: "+14155552671", Channel: "sms", Locale: "pt-BR" })
  assert.equal(calls[0]!.url.toString(), `https://verify.twilio.com/v2/Services/${VA}/Verifications`)
  const form = new URLSearchParams(calls[0]!.body as string)
  assert.equal(form.get("To"), "+14155552671")
  assert.equal(form.get("Channel"), "sms")
  assert.equal(form.get("Locale"), "pt-BR")
  assert.equal(form.has("ServiceSid"), false)
})

test("checking a code sends the code and the number, and needs exactly one of To or VerificationSid", async () => {
  const { conn, calls } = harness(verify, () => json({ ...verification, status: "approved", valid: true }), connect)
  const result = (await conn.execute("verifications.check", { ServiceSid: VA, VerificationSid: VE, Code: "123456" })) as { status: string; valid: boolean }
  assert.equal(result.status, "approved")
  assert.equal(calls[0]!.url.pathname, `/v2/Services/${VA}/VerificationCheck`)
  assert.equal(new URLSearchParams(calls[0]!.body as string).get("Code"), "123456")
  for (const input of [{ ServiceSid: VA, Code: "123456" }, { ServiceSid: VA, To: "+14155552671", VerificationSid: VE, Code: "123456" }]) {
    await assert.rejects(() => conn.execute("verifications.check", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(calls.length, 1)
})

test("services page by meta.next_page_url (an absolute link)", async () => {
  const NEXT = "https://verify.twilio.com/v2/Services?PageSize=1&Page=1&PageToken=PA1"
  const { conn, calls } = harness(verify, (call) => json(call.url.searchParams.get("PageToken") ? { services: [], meta: { next_page_url: null } } : { services: [{ sid: VA }], meta: { next_page_url: NEXT } }), connect)
  const first = (await conn.execute("services.list", { pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(first.nextCursor, NEXT)
  await conn.execute("services.list", { cursor: NEXT })
  assert.equal(calls[1]!.url.toString(), NEXT)
})

test("a verification link on another host is refused", async () => {
  const { conn, calls } = harness(verify, () => json({ services: [] }), connect)
  await assert.rejects(() => conn.execute("services.list", { cursor: "https://evil.example/v2/Services" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})
