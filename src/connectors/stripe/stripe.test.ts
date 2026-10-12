import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import stripe from "./index.js"

const list = (data: unknown[], more = false) => ({ object: "list", data, has_more: more, url: "/v1/x" })
const customer = { id: "cus_1", email: "ada@acme.dev", name: "Ada", created: 1760000000, metadata: { plan: "pro" }, livemode: false }
const pi = { id: "pi_1", amount: 2000, currency: "usd", status: "requires_payment_method", customer: "cus_1" }
const charge = { id: "ch_1", amount: 2000, currency: "usd", status: "succeeded", paid: true }
const invoice = { id: "in_1", status: "open", customer: "cus_1", amount_due: 500 }
const subscription = { id: "sub_1", status: "active", customer: "cus_1" }
const product = { id: "prod_1", name: "Pro plan", active: true }
const price = { id: "price_1", currency: "usd", unit_amount: 900, product: "prod_1", type: "recurring" }
const refund = { id: "re_1", amount: 500, currency: "usd", status: "succeeded", charge: "ch_1" }
const session = { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", status: "open", mode: "payment" }
const search = (data: unknown[], next: string | null) => ({ object: "search_result", data, has_more: next !== null, next_page: next, url: "/v1/x/search" })

const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; badInput?: Record<string, unknown> }> = [
  { action: "balance.get", input: {}, ok: { available: [{ amount: 1000, currency: "usd" }], pending: [] } },
  { action: "customers.list", input: {}, ok: list([customer]), badInput: { email: 5 } },
  { action: "customers.search", input: { query: "email:'ada@acme.dev'" }, ok: search([customer], null), badInput: { query: "" } },
  { action: "customers.get", input: { customer: "cus_1" }, ok: customer, badInput: { customer: 7 } },
  { action: "customers.create", input: { email: "ada@acme.dev" }, ok: customer, badInput: { email: 7 } },
  { action: "customers.update", input: { customer: "cus_1", name: "Ada L" }, ok: customer, badInput: { customer: "" } },
  { action: "paymentIntents.list", input: {}, ok: list([pi]), badInput: { customer: 3 } },
  { action: "paymentIntents.get", input: { intent: "pi_1" }, ok: pi, badInput: { intent: "" } },
  { action: "paymentIntents.create", input: { amount: 2000, currency: "usd" }, ok: pi, badInput: { amount: 0, currency: "usd" } },
  { action: "paymentIntents.cancel", input: { intent: "pi_1" }, ok: pi, badInput: { intent: "pi_1", cancellation_reason: "because" } },
  { action: "charges.list", input: {}, ok: list([charge]), badInput: { customer: 3 } },
  { action: "charges.get", input: { charge: "ch_1" }, ok: charge, badInput: { charge: "" } },
  { action: "invoices.list", input: {}, ok: list([invoice]), badInput: { status: "maybe" } },
  { action: "invoices.get", input: { invoice: "in_1" }, ok: invoice, badInput: { invoice: "" } },
  { action: "subscriptions.list", input: {}, ok: list([subscription]), badInput: { status: "maybe" } },
  { action: "subscriptions.get", input: { subscription_exposed_id: "sub_1" }, ok: subscription, badInput: { subscription_exposed_id: "" } },
  { action: "subscriptions.cancel", input: { subscription_exposed_id: "sub_1" }, ok: subscription, badInput: { subscription_exposed_id: "sub_1", prorate: "yes" } },
  { action: "products.list", input: {}, ok: list([product]), badInput: { active: "yes" } },
  { action: "products.create", input: { name: "Pro plan" }, ok: product, badInput: { name: "" } },
  { action: "prices.list", input: {}, ok: list([price]), badInput: { type: "weekly" } },
  { action: "refunds.create", input: { charge: "ch_1", amount: 500 }, ok: refund, badInput: { charge: "ch_1", amount: -5 } },
  { action: "checkoutSessions.create", input: { mode: "payment", success_url: "https://acme.dev/ok", line_items: [{ price: "price_1", quantity: 1 }] }, ok: session, badInput: { mode: "barter", success_url: "https://acme.dev/ok" } },
]
for (const c of cases) standardTests(stripe, { action: c.action, input: c.input, ok: c.ok, ...(c.badInput && { badInput: c.badInput }) })

const h = (respond: Parameters<typeof harness>[1]) => harness(stripe, respond, { credentials: { token: "sk_test_123" } })
const body = (call: { init: RequestInit }) => decodeURIComponent(String(call.init.body))

test("requests go to /v1 with the key as a Bearer token and a pinned API version", async () => {
  const { conn, calls } = h(() => json(customer))
  await conn.execute("customers.get", { customer: "cus_1" })
  assert.equal(calls[0]!.url.toString(), "https://api.stripe.com/v1/customers/cus_1")
  assert.equal(calls[0]!.header("authorization"), "Bearer sk_test_123")
  assert.match(calls[0]!.header("stripe-version")!, /^\d{4}-\d{2}-\d{2}/)
})

test("a write is form-encoded, with nested metadata in bracket notation", async () => {
  const { conn, calls } = h(() => json(customer))
  await conn.execute("customers.create", { email: "ada@acme.dev", metadata: { plan: "pro", note: "a&b" } })
  assert.equal(calls[0]!.header("content-type"), "application/x-www-form-urlencoded")
  assert.equal(body(calls[0]!), "email=ada@acme.dev&metadata[plan]=pro&metadata[note]=a&b")
  assert.ok(String(calls[0]!.init.body).includes("a%26b"), "an & in a value cannot start a new field")
})

test("a payment is created in the smallest currency unit and an array of line items is indexed", async () => {
  const { conn, calls } = h(() => json(session))
  await conn.execute("checkoutSessions.create", { mode: "payment", success_url: "https://acme.dev/ok", line_items: [{ price: "price_1", quantity: 2 }, { price: "price_2", quantity: 1 }] })
  assert.equal(calls[0]!.url.pathname, "/v1/checkout/sessions")
  assert.equal(body(calls[0]!), "mode=payment&success_url=https://acme.dev/ok&line_items[0][price]=price_1&line_items[0][quantity]=2&line_items[1][price]=price_2&line_items[1][quantity]=1")
})

test("a money amount must be a positive whole number: 20.5 dollars is refused before anything is sent", async () => {
  const { conn, calls } = h(() => json(pi))
  for (const amount of [20.5, 0, -1]) await assert.rejects(() => conn.execute("paymentIntents.create", { amount, currency: "usd" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("a retried POST reuses its idempotency key, so a charge cannot be made twice", async () => {
  let n = 0
  const { conn, calls } = harness(stripe, () => (++n === 1 ? json({ error: { message: "oops" } }, 503) : json(pi)), { credentials: { token: "sk_test_123" }, retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("paymentIntents.create", { amount: 2000, currency: "usd" })
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.header("idempotency-key"))
  assert.equal(calls[0]!.header("idempotency-key"), calls[1]!.header("idempotency-key"))
})

test("a list pages by the last id, and a search pages by next_page", async () => {
  const lists = h((call) => json(call.url.searchParams.get("starting_after") === "cus_2" ? list([{ ...customer, id: "cus_3" }]) : list([{ ...customer, id: "cus_1" }, { ...customer, id: "cus_2" }], true)))
  const first = (await lists.conn.execute("customers.list", { pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(lists.calls[0]!.url.searchParams.get("limit"), "2")
  assert.equal(first.nextCursor, "cus_2")
  const second = (await lists.conn.execute("customers.list", { cursor: "cus_2" })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(lists.calls[1]!.url.searchParams.get("starting_after"), "cus_2")
  assert.equal(second.nextCursor, null)

  const found = h((call) => json(call.url.searchParams.get("page") === "tok2" ? search([customer], null) : search([customer], "tok2")))
  const p1 = (await found.conn.execute("customers.search", { query: "name:'Ada'" })) as { nextCursor: string | null }
  assert.equal(found.calls[0]!.url.searchParams.get("query"), "name:'Ada'")
  assert.equal(p1.nextCursor, "tok2")
  await found.conn.execute("customers.search", { query: "name:'Ada'", cursor: "tok2" })
  assert.equal(found.calls[1]!.url.searchParams.get("page"), "tok2")
})

test("list filters use bracket notation: created[gte] and expand[0]", async () => {
  const { conn, calls } = h(() => json(list([])))
  await conn.execute("charges.list", { created: { gte: 1760000000 }, expand: ["data.customer"] })
  assert.equal(decodeURIComponent(calls[0]!.url.search), "?created[gte]=1760000000&expand[0]=data.customer&limit=25")
})

test("a refund names exactly one of charge or payment intent, and is a destructive action", async () => {
  assert.equal(stripe.actions["refunds.create"]!.effect, "destructive")
  const { conn, calls } = h(() => json(refund))
  for (const input of [{}, { charge: "ch_1", payment_intent: "pi_1" }]) await assert.rejects(() => conn.execute("refunds.create", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
  await conn.execute("refunds.create", { payment_intent: "pi_1", reason: "duplicate" })
  assert.equal(body(calls[0]!), "payment_intent=pi_1&reason=duplicate")
})

test("cancelling a subscription is a DELETE whose options travel in the form body", async () => {
  const { conn, calls } = h(() => json(subscription))
  await conn.execute("subscriptions.cancel", { subscription_exposed_id: "sub_1", prorate: false })
  assert.equal(calls[0]!.init.method, "DELETE")
  assert.equal(calls[0]!.url.pathname, "/v1/subscriptions/sub_1")
  assert.equal(body(calls[0]!), "prorate=false")
  assert.equal(calls[0]!.header("idempotency-key"), null, "only POST carries the key")
})

test("a path value cannot escape its segment", async () => {
  const { conn, calls } = h(() => json(customer))
  await assert.rejects(() => conn.execute("customers.get", { customer: ".." }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("a generated action works: confirm a payment intent sends a form body to the right path", async () => {
  const { conn, calls } = h(() => json(pi))
  await (conn as unknown as { execute(a: string, i: unknown): Promise<unknown> }).execute("paymentIntents.confirm", { intent: "pi_1", payment_method: "pm_card_visa", return_url: "https://acme.dev/back" })
  assert.equal(calls[0]!.url.pathname, "/v1/payment_intents/pi_1/confirm")
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(body(calls[0]!), "payment_method=pm_card_visa&return_url=https://acme.dev/back")
  assert.ok(calls[0]!.header("idempotency-key"))
})

test("the API's own error text stays out of the thrown error but is kept in raw", async () => {
  const { conn } = h(() => json({ error: { type: "card_error", code: "card_declined", message: "Your card was declined: 4242 4242 4242 4242" } }, 402))
  await assert.rejects(() => conn.execute("paymentIntents.get", { intent: "pi_1" }), (e: unknown) => {
    const err = e as Error & { code: string; raw?: { body: string } }
    return err.code === "upstream_error" && !JSON.stringify(err).includes("4242") && !err.message.includes("4242") && String(err.raw?.body).includes("card_declined")
  })
})
