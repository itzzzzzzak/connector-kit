import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { ConnectorKitError, defineConnector, lastItemPagination } from "./index.js"
import { encodeForm } from "./form.js"
import { harness, json } from "./connector-harness.test.js"

// ----------------------------------------------------------------- the encoder

test("form: scalars, nested objects and indexed arrays use bracket notation", () => {
  const text = encodeForm({ amount: 2000, live: false, metadata: { order: "6735", note: "a b&c" }, items: [{ price: "p1", quantity: 2 }, { price: "p2" }], tags: ["x", "y"] })
  assert.equal(
    decodeURIComponent(text),
    "amount=2000&live=false&metadata[order]=6735&metadata[note]=a b&c&items[0][price]=p1&items[0][quantity]=2&items[1][price]=p2&tags[0]=x&tags[1]=y",
  )
  assert.ok(text.includes("a%20b%26c"), "values are percent-encoded so & cannot start a new field")
})

test("form: repeat style repeats the key for arrays", () => {
  assert.equal(encodeForm({ To: ["+1", "+2"], Body: "hi" }, "repeat"), "To=%2B1&To=%2B2&Body=hi")
})

test("form: null clears a field, undefined and empty lists are left out", () => {
  assert.equal(encodeForm({ description: null, name: undefined, expand: [] }), "description=")
})

test("form: a value that cannot be encoded is an error, not 'undefined' on the wire", () => {
  assert.throws(() => encodeForm({ f: () => 1 } as never), TypeError)
})

// ----------------------------------------------------------------- the runtime

const pay = defineConnector({
  name: "pay",
  baseUrl: "https://api.pay.test/v1",
  auth: { type: "bearer" },
  bodyFormat: "form",
  idempotencyKeyHeader: "Idempotency-Key",
  actions: {
    "charges.create": {
      description: "Create a charge; the provider takes form-encoded bodies.",
      method: "POST",
      path: "/charges",
      input: z.object({ amount: z.number(), metadata: z.record(z.string(), z.string()).optional(), items: z.array(z.object({ price: z.string() })).optional() }),
      output: z.object({ id: z.string() }),
      effect: "write",
    },
    "charges.list": {
      description: "List charges with filters, in the provider's bracket notation.",
      method: "GET",
      path: "/charges",
      input: z.object({ created: z.record(z.string(), z.number()).optional(), expand: z.array(z.string()).optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
      paginate: lastItemPagination(),
    },
    "charges.delete": { description: "Permanently delete a charge (it cannot be recovered).", method: "DELETE", path: "/charges/{id}", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), effect: "destructive" },
  },
})

const retry = { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } }

test("a form connector sends an urlencoded body and the right content type", async () => {
  const { conn, calls } = harness(pay, () => json({ id: "ch_1" }))
  await conn.execute("charges.create", { amount: 2000, metadata: { order: "1" }, items: [{ price: "p1" }] })
  assert.equal(calls[0]!.header("content-type"), "application/x-www-form-urlencoded")
  assert.equal(decodeURIComponent(String(calls[0]!.init.body)), "amount=2000&metadata[order]=1&items[0][price]=p1")
})

test("a form connector sends nested query values in bracket notation", async () => {
  const { conn, calls } = harness(pay, () => json({ data: [], has_more: false }))
  await conn.execute("charges.list", { created: { gte: 100 }, expand: ["data.customer"] })
  assert.equal(decodeURIComponent(calls[0]!.url.search), "?created[gte]=100&expand[0]=data.customer&limit=25")
})

test("last-item paging: the next cursor is the last id, and the last page has none", async () => {
  const pages = [
    { data: [{ id: "a" }, { id: "b" }], has_more: true },
    { data: [{ id: "c" }], has_more: false },
  ]
  const { conn, calls } = harness(pay, (call) => json(call.url.searchParams.get("starting_after") === "b" ? pages[1] : pages[0]))
  const first = (await conn.execute("charges.list", {})) as { items: unknown[]; nextCursor: string | null }
  assert.equal(first.nextCursor, "b")
  const second = (await conn.execute("charges.list", { cursor: first.nextCursor! })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(calls[1]!.url.searchParams.get("starting_after"), "b")
  assert.deepEqual(second, { items: [{ id: "c" }], nextCursor: null })
})

test("last-item paging: has_more without a usable id ends paging instead of looping", async () => {
  const { conn } = harness(pay, () => json({ data: [{ id: "" }], has_more: true }))
  assert.equal(((await conn.execute("charges.list", {})) as { nextCursor: string | null }).nextCursor, null)
})

test("a POST carries an idempotency key, and a retry reuses the SAME key", async () => {
  let n = 0
  const { conn, calls } = harness(pay, () => (++n === 1 ? json({}, 503) : json({ id: "ch_1" })), retry)
  await conn.execute("charges.create", { amount: 1 })
  assert.equal(calls.length, 2, "a POST is retried once the provider can drop a duplicate")
  const keys = calls.map((c) => c.header("idempotency-key"))
  assert.ok(keys[0] && keys[0] === keys[1])
})

test("each call gets its own idempotency key", async () => {
  const { conn, calls } = harness(pay, () => json({ id: "ch_1" }))
  await conn.execute("charges.create", { amount: 1 })
  await conn.execute("charges.create", { amount: 1 })
  assert.notEqual(calls[0]!.header("idempotency-key"), calls[1]!.header("idempotency-key"))
})

test("GET and DELETE get no idempotency key, and a DELETE is not retried after a 5xx", async () => {
  const { conn, calls } = harness(pay, () => json({}, 503), retry)
  await assert.rejects(() => conn.execute("charges.delete", { id: "ch_1" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.header("idempotency-key"), null)
})
