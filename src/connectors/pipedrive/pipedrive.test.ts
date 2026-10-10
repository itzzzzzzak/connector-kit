import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import pipedrive from "./index.js"

const deal = { id: 7, title: "Big deal", owner_id: 1, person_id: 3, org_id: null, pipeline_id: 1, stage_id: 2, value: 5000, currency: "USD", status: "open", expected_close_date: "2026-12-01", add_time: "2026-10-01T00:00:00Z", lost_reason: null, label_ids: [] }
const person = { id: 3, name: "Ada L", emails: [{ value: "ada@x.dev", primary: true, label: "work" }], phones: [], org_id: 9, job_title: null }
const list = (data: unknown[], next?: string) => ({ success: true, data, additional_data: next ? { next_cursor: next } : {} })
const one = (data: unknown) => ({ success: true, data })

standardTests(pipedrive, { action: "deals.list", input: {}, ok: list([deal]), badInput: { stage_id: "two" } })
standardTests(pipedrive, { action: "deals.get", input: { id: 7 }, ok: one(deal), badInput: { id: "seven" } })
standardTests(pipedrive, { action: "deals.create", input: { title: "x" }, ok: one(deal), badInput: { title: 5 } })
standardTests(pipedrive, { action: "deals.update", input: { id: 7, status: "won" }, ok: one(deal), badInput: { id: "seven" } })
standardTests(pipedrive, { action: "persons.list", input: {}, ok: list([person]), badInput: { org_id: "x" } })
standardTests(pipedrive, { action: "persons.get", input: { id: 3 }, ok: one(person), badInput: { id: "x" } })
standardTests(pipedrive, { action: "persons.create", input: { name: "Ada" }, ok: one(person), badInput: { name: 5 } })
standardTests(pipedrive, { action: "organizations.list", input: {}, ok: list([{ id: 9, name: "Acme" }]), badInput: { owner_id: "x" } })
standardTests(pipedrive, { action: "organizations.get", input: { id: 9 }, ok: one({ id: 9, name: "Acme", address: null }), badInput: { id: "x" } })
standardTests(pipedrive, { action: "pipelines.list", input: {}, ok: list([{ id: 1, name: "Sales" }]), badInput: { sort_by: "color" } })

test("the token goes in x-api-token and the v2 base URL is used", async () => {
  const { conn, calls } = harness(pipedrive, () => json(list([deal])), { credentials: { token: "pd-secret" } })
  await conn.execute("deals.list", { status: "open", owner_id: 1 })
  assert.equal(calls[0]!.header("x-api-token"), "pd-secret")
  assert.equal(calls[0]!.header("authorization"), null)
  assert.equal(calls[0]!.url.pathname, "/api/v2/deals")
  assert.equal(calls[0]!.url.searchParams.get("status"), "open")
  assert.equal(calls[0]!.url.searchParams.get("limit"), "30")
})

test("pagination follows additional_data.next_cursor as 'cursor' and keeps the filters; the page size caps at 500", async () => {
  const { kit, conn, calls } = harness(pipedrive, (c) => json(c.url.searchParams.has("cursor") ? list([{ ...deal, id: 8 }]) : list([deal], "CUR2")))
  const ids: number[] = []
  for await (const d of kit.paginate(conn, "deals.list", { pipeline_id: 1, pageSize: 9999 })) ids.push(d.id)
  assert.deepEqual(ids, [7, 8])
  assert.equal(calls[0]!.url.searchParams.get("limit"), "500")
  assert.equal(calls[1]!.url.searchParams.get("cursor"), "CUR2")
  assert.ok(calls.every((c) => c.url.searchParams.get("pipeline_id") === "1"))
})

test("missing next_cursor means the last page", async () => {
  const { conn } = harness(pipedrive, () => json(list([deal])))
  assert.equal((await conn.execute("deals.list", {})).nextCursor, null)
})

test("null links (a deal with no organization) are accepted", async () => {
  const { conn } = harness(pipedrive, () => json(one(deal)))
  assert.equal((await conn.execute("deals.get", { id: 7 })).data.org_id, null)
})

test("deals.create sends the fields as the body and is NOT retried", async () => {
  const { conn, calls } = harness(pipedrive, () => json(one(deal), 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("deals.create", { title: "Big deal", value: 5000, currency: "USD", person_id: 3 })
  assert.equal(calls[0]!.init.method, "POST")
  assert.deepEqual(calls[0]!.body, { title: "Big deal", value: 5000, currency: "USD", person_id: 3 })
})

test("deals.update is a PATCH with the id only in the path, and IS retried (idempotent)", async () => {
  let n = 0
  const { conn, calls } = harness(pipedrive, () => (++n === 1 ? json({}, 503) : json(one(deal))), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("deals.update", { id: 7, status: "lost", lost_reason: "price" })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, "PATCH")
  assert.equal(calls[1]!.url.pathname, "/api/v2/deals/7")
  assert.deepEqual(calls[1]!.body, { status: "lost", lost_reason: "price" })
})

test("persons.create accepts a list of emails with labels and rejects a malformed one", async () => {
  const { conn, calls } = harness(pipedrive, () => json(one(person), 201))
  await conn.execute("persons.create", { name: "Ada", emails: [{ value: "ada@x.dev", primary: true, label: "work" }] })
  assert.deepEqual((calls[0]!.body as { emails: unknown[] }).emails, [{ value: "ada@x.dev", primary: true, label: "work" }])
  await assert.rejects(() => conn.execute("persons.create", { name: "Ada", emails: "ada@x.dev" as never }))
  assert.equal(calls.length, 1)
})

test("a currency code that is not three letters, or a non-positive id, is rejected before sending", async () => {
  const { conn, calls } = harness(pipedrive, () => json(one(deal)))
  await assert.rejects(() => conn.execute("deals.create", { title: "x", currency: "DOLLARS" }))
  await assert.rejects(() => conn.execute("deals.get", { id: 0 }))
  assert.equal(calls.length, 0)
})
