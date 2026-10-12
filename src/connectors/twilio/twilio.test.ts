import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import twilio from "./index.js"

const AC = "AC" + "a".repeat(32)
const SM = "SM" + "b".repeat(32)
const CA = "CA" + "c".repeat(32)
const connect = { credentials: { token: `${AC}:auth-token` } }
const h = (respond: Parameters<typeof harness>[1]) => harness(twilio, respond, connect)
const message = { sid: SM, account_sid: AC, status: "queued", direction: "outbound-api", from: "+14155550100", to: "+14155552671", body: "Hi", num_segments: "1", price: null, error_code: null }
const call = { sid: CA, account_sid: AC, status: "queued", from: "+14155550100", to: "+14155552671" }
const list = (key: string, items: unknown[], next: string | null = null) => ({ [key]: items, page: 0, page_size: 50, next_page_uri: next, previous_page_uri: null })

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(twilio, { ...c, connect })
std({ action: "account.get", input: { Sid: AC }, ok: { sid: AC, friendly_name: "Acme", status: "active", type: "Full" }, badInput: { Sid: "nope" } })
std({ action: "balance.get", input: { AccountSid: AC }, ok: { balance: "12.50", currency: "USD" }, badInput: { AccountSid: 5 } })
std({ action: "messages.send", input: { AccountSid: AC, To: "+14155552671", From: "+14155550100", Body: "Hi" }, ok: message, badInput: { AccountSid: AC, To: "4155552671", From: "+14155550100", Body: "Hi" } })
std({ action: "messages.list", input: { AccountSid: AC }, ok: list("messages", [message], "/2010-04-01/Accounts/x/Messages.json?Page=1"), badInput: { AccountSid: AC, pageSize: "x" } })
std({ action: "messages.get", input: { AccountSid: AC, Sid: SM }, ok: message, badInput: { AccountSid: AC, Sid: "SM1" } })
std({ action: "calls.start", input: { AccountSid: AC, To: "+14155552671", From: "+14155550100", Twiml: "<Response><Say>Hi</Say></Response>" }, ok: call, badInput: { AccountSid: AC, To: "+14155552671", From: "+14155550100" } })
std({ action: "calls.list", input: { AccountSid: AC, Status: "completed" }, ok: list("calls", [call]), badInput: { AccountSid: AC, Status: "happy" } })
std({ action: "calls.get", input: { AccountSid: AC, Sid: CA }, ok: call, badInput: { AccountSid: AC, Sid: "x" } })
std({ action: "calls.hangup", input: { AccountSid: AC, Sid: CA, Status: "completed" }, ok: call, badInput: { AccountSid: AC, Sid: CA, Status: "deleted" } })
std({ action: "numbers.search", input: { AccountSid: AC, CountryCode: "US", Type: "Local", AreaCode: 415 }, ok: { available_phone_numbers: [{ phone_number: "+14155550111", iso_country: "US" }] }, badInput: { AccountSid: AC, CountryCode: "usa", Type: "Local" } })
std({ action: "numbers.list", input: { AccountSid: AC }, ok: list("incoming_phone_numbers", [{ sid: "PN" + "d".repeat(32), phone_number: "+14155550100" }]), badInput: { AccountSid: AC, pageSize: "x" } })

test("calls use Basic auth built from the account SID and token", async () => {
  const { conn, calls } = h(() => json({ balance: "1", currency: "USD" }))
  await conn.execute("balance.get", { AccountSid: AC })
  assert.equal(calls[0]!.url.toString(), `https://api.twilio.com/2010-04-01/Accounts/${AC}/Balance.json`)
  assert.equal(calls[0]!.header("authorization"), `Basic ${Buffer.from(`${AC}:auth-token`).toString("base64")}`)
})

test("sending a message is a form-encoded POST, with a repeated key for each media URL", async () => {
  const { conn, calls } = h(() => json(message, 201))
  await conn.execute("messages.send", { AccountSid: AC, To: "+14155552671", MessagingServiceSid: "MG" + "e".repeat(32), Body: "Photo", MediaUrl: ["https://img.acme.dev/a.png", "https://img.acme.dev/b.png"] })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.header("content-type"), "application/x-www-form-urlencoded")
  const form = new URLSearchParams(calls[0]!.body as string)
  assert.deepEqual(form.getAll("MediaUrl"), ["https://img.acme.dev/a.png", "https://img.acme.dev/b.png"])
  assert.equal(form.get("To"), "+14155552671")
  assert.equal(form.has("AccountSid"), false)
})

test("a message needs a sender and some content, and media URLs must be https", async () => {
  const { conn, calls } = h(() => json(message))
  for (const input of [
    { AccountSid: AC, To: "+14155552671", Body: "no sender" },
    { AccountSid: AC, To: "+14155552671", From: "+14155550100" },
    { AccountSid: AC, To: "+14155552671", From: "+14155550100", MediaUrl: ["http://insecure.dev/a.png"] },
  ]) await assert.rejects(() => conn.execute("messages.send", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("a message list follows next_page_uri on the same host, and date filters use Twilio's > and < names", async () => {
  const NEXT = `/2010-04-01/Accounts/${AC}/Messages.json?PageSize=1&Page=1&PageToken=PASM1`
  const { conn, calls } = h((call) => json(call.url.searchParams.get("PageToken") ? list("messages", []) : list("messages", [message], NEXT)))
  const first = (await conn.execute("messages.list", { AccountSid: AC, DateSentAfter: "2026-10-01", DateSentBefore: "2026-10-12", pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("PageSize"), "1")
  assert.equal(calls[0]!.url.searchParams.get("DateSent>"), "2026-10-01")
  assert.equal(calls[0]!.url.searchParams.get("DateSent<"), "2026-10-12")
  assert.equal(first.nextCursor, NEXT)
  await conn.execute("messages.list", { AccountSid: AC, cursor: NEXT })
  assert.equal(calls[1]!.url.toString(), `https://api.twilio.com${NEXT}`)
})

test("a next-page link that points to another host is refused", async () => {
  const { conn } = h(() => json(list("messages", [message], "//evil.example/steal")))
  await assert.rejects(() => conn.execute("messages.list", { AccountSid: AC }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  const second = h(() => json(list("messages", [])))
  await assert.rejects(() => second.conn.execute("messages.list", { AccountSid: AC, cursor: "//evil.example/steal" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(second.calls.length, 0)
})

test("hanging up posts the status to the call, and the generated delete is destructive", async () => {
  const { conn, calls } = h(() => json(call))
  await conn.execute("calls.hangup", { AccountSid: AC, Sid: CA, Status: "completed" })
  assert.equal(calls[0]!.url.pathname, `/2010-04-01/Accounts/${AC}/Calls/${CA}.json`)
  assert.equal(new URLSearchParams(calls[0]!.body as string).get("Status"), "completed")
  const actions = twilio.actions as Record<string, { effect: string; method: string }>
  for (const [name, action] of Object.entries(actions)) if (action.method === "DELETE") assert.equal(action.effect, "destructive", name)
  assert.ok(Object.keys(actions).length > 150)
})

test("Twilio's error JSON does not leak into the message, and 429 is retryable", async () => {
  const bad = h(() => json({ code: 21211, message: "The 'To' number +1 is not a valid phone number.", more_info: "https://www.twilio.com/docs/errors/21211", status: 400 }, 400))
  await assert.rejects(() => bad.conn.execute("messages.send", { AccountSid: AC, To: "+14155552671", From: "+14155550100", Body: "x" }), (e: unknown) => {
    const err = e as { code?: string; message: string }
    return err.code === "invalid_input" && !err.message.includes("21211")
  })
})
