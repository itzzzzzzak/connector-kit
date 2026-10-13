import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import paypal from "./index.js"

const connect = { variables: { api: "api-m" }, credentials: { token: "A21AAL.ACCESS" } }
const h = (respond: Parameters<typeof harness>[1], extra = {}) => harness(paypal, respond, { ...connect, ...extra })
const std = (c: Parameters<typeof standardTests>[1]) => standardTests(paypal, { ...c, connect })
const order = { id: "5O190127TN364715T", status: "CREATED", intent: "CAPTURE", links: [{ rel: "payer-action", href: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T" }] }
const amount = { currencyCode: "USD", value: "10.00" }
const inv = { id: "INV2-Z56S-5LLA-Q52L-CPZ5", status: "SENT", detail: { invoice_number: "0001", currency_code: "USD" }, amount: { value: "55.00" } }

std({ action: "order.create", input: { amount }, ok: order, badInput: { amount: { currencyCode: "usd", value: "10.00" } } })
std({ action: "order.get", input: { orderId: order.id }, ok: order, badInput: { orderId: "a/b" } })
std({ action: "order.capture", input: { orderId: order.id }, ok: { ...order, status: "COMPLETED" }, badInput: { orderId: "" } })
std({ action: "capture.get", input: { captureId: "3C679366HH908993F" }, ok: { id: "3C679366HH908993F", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" } }, badInput: { captureId: "x" } })
std({ action: "capture.refund", input: { captureId: "3C679366HH908993F", amount }, ok: { id: "1JU08902781691411", status: "COMPLETED" }, badInput: { captureId: "3C679366HH908993F", amount: { currencyCode: "USD", value: "ten" } } })
std({ action: "invoices.list", input: {}, ok: { total_items: 1, total_pages: 1, items: [inv] }, badInput: { pageSize: 5000 } })
std({ action: "invoice.get", input: { invoiceId: inv.id }, ok: inv, badInput: { invoiceId: "123" } })
std({ action: "transactions.search", input: { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-08T00:00:00Z" }, ok: { transaction_details: [{ transaction_info: { transaction_id: "T1", transaction_status: "S" } }], total_items: 1, page: 1 }, badInput: { startDate: "yesterday", endDate: "2026-10-08T00:00:00Z" } })
std({ action: "balances.get", input: {}, ok: { balances: [{ currency: "USD", total_balance: { currency_code: "USD", value: "100.00" } }] }, badInput: { asOfTime: "now" } })

test("the variable picks live or sandbox host; anything else is refused", async () => {
  const sandbox = h(() => json(order), { variables: { api: "api-m.sandbox" } })
  await sandbox.conn.execute("order.get", { orderId: order.id })
  assert.equal(sandbox.calls[0]!.url.host, "api-m.sandbox.paypal.com")
  assert.throws(() => h(() => json(order), { variables: { api: "evil.example.com/" } }))
})

test("an order is created with a string amount, the intent and an idempotency key reused on retry", async () => {
  let n = 0
  const { conn, calls } = h(() => (++n === 1 ? json({}, 503) : json(order)), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("order.create", { amount, description: "Hat", returnUrl: "https://example.com/ok" })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]!.body, { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" }, description: "Hat" }], payment_source: { paypal: { experience_context: { return_url: "https://example.com/ok" } } } })
  const key = calls[0]!.header("PayPal-Request-Id")
  assert.ok(key && key.length >= 16)
  assert.equal(calls[1]!.header("PayPal-Request-Id"), key)
})

test("a refund names the capture in the path and sends the amount in PayPal's shape; without one it refunds all", async () => {
  const { conn, calls } = h(() => json({ id: "R1", status: "COMPLETED" }))
  await conn.execute("capture.refund", { captureId: "3C679366HH908993F", amount: { currencyCode: "EUR", value: "2.50" }, noteToPayer: "Sorry" })
  await conn.execute("capture.refund", { captureId: "3C679366HH908993F" })
  assert.equal(calls[0]!.url.pathname, "/v2/payments/captures/3C679366HH908993F/refund")
  assert.deepEqual(calls[0]!.body, { amount: { currency_code: "EUR", value: "2.50" }, note_to_payer: "Sorry" })
  assert.deepEqual(calls[1]!.body, {})
})

test("lists page by number from 1 and stop when the total is reached", async () => {
  const more = h(() => json({ total_items: 5, items: [inv, inv] }))
  const page = (await more.conn.execute("invoices.list", { pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(more.calls[0]!.url.searchParams.get("page_size"), "2")
  assert.equal(more.calls[0]!.url.searchParams.get("total_required"), "true")
  assert.equal(page.nextCursor, "2")
  const last = h(() => json({ total_items: 1, items: [inv] }))
  assert.equal(((await last.conn.execute("invoices.list", {})) as { nextCursor: string | null }).nextCursor, null)
})

test("the transaction search sends its window and status as PayPal's query names", async () => {
  const { conn, calls } = h(() => json({ transaction_details: [], total_items: 0 }))
  await conn.execute("transactions.search", { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-08T00:00:00Z", transactionStatus: "S" })
  const q = calls[0]!.url.searchParams
  assert.equal(q.get("start_date"), "2026-10-01T00:00:00Z")
  assert.equal(q.get("end_date"), "2026-10-08T00:00:00Z")
  assert.equal(q.get("transaction_status"), "S")
})

test("a refund is destructive, capturing and creating are writes", () => {
  assert.equal(paypal.actions["capture.refund"].effect, "destructive")
  assert.equal(paypal.actions["order.capture"].effect, "write")
  assert.equal(paypal.actions["order.create"].effect, "write")
})
