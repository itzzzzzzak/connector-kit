import assert from "node:assert/strict"
import { test } from "node:test"
import airtable from "./index.js"
import { harness, json, standardTests } from "../../connector-harness.test.js"

const rec = { id: "rec1", createdTime: "2026-01-01T00:00:00.000Z", fields: { Name: "Ship it", Status: "Todo", Tags: ["a", "b"] } }
const where = { baseId: "appX", tableIdOrName: "Tasks" }

standardTests(airtable, { action: "bases.list", input: {}, ok: { bases: [{ id: "appX", name: "Work", permissionLevel: "create" }] }, badInput: { pageSize: "x" } })
standardTests(airtable, { action: "tables.list", input: { baseId: "appX" }, ok: { tables: [{ id: "tbl1", name: "Tasks", fields: [{ id: "fld1", name: "Name", type: "singleLineText" }] }] }, badInput: { baseId: 5 } })
standardTests(airtable, { action: "records.list", input: where, ok: { records: [rec] }, badInput: { ...where, maxRecords: "ten" } })
standardTests(airtable, { action: "records.get", input: { ...where, recordId: "rec1" }, ok: rec, badInput: { ...where, recordId: 1 } })
standardTests(airtable, { action: "records.create", input: { ...where, fields: { Name: "x" } }, ok: rec, badInput: { ...where, fields: "Name" } })
standardTests(airtable, { action: "records.update", input: { ...where, recordId: "rec1", fields: { Name: "y" } }, ok: rec, badInput: { ...where, recordId: 1, fields: {} } })
standardTests(airtable, { action: "records.delete", input: { ...where, recordId: "rec1" }, ok: { id: "rec1", deleted: true }, badInput: { ...where, recordId: 1 } })

test("records.list builds Airtable's bracket-style query and an encoded table name in the path", async () => {
  const { conn, calls } = harness(airtable, () => json({ records: [rec] }))
  await conn.execute("records.list", { baseId: "appX", tableIdOrName: "My Tasks", fields: ["Name", "Status"], filterByFormula: "{Status}='Todo'", view: "Grid view", maxRecords: 50, sort_field: "Name", sort_direction: "desc" })
  const { url } = calls[0]!
  assert.equal(url.pathname, "/v0/appX/My%20Tasks")
  assert.deepEqual(url.searchParams.getAll("fields[]"), ["Name", "Status"])
  assert.equal(url.searchParams.get("filterByFormula"), "{Status}='Todo'")
  assert.equal(url.searchParams.get("sort[0][field]"), "Name")
  assert.equal(url.searchParams.get("sort[0][direction]"), "desc")
  assert.equal(url.searchParams.get("maxRecords"), "50")
  assert.equal(url.searchParams.get("pageSize"), "30")
})

test("records.list follows the body's offset and keeps every filter on each page; pageSize caps at 100", async () => {
  const { kit, conn, calls } = harness(airtable, (c) => json(c.url.searchParams.has("offset") ? { records: [{ ...rec, id: "rec2" }] } : { records: [rec], offset: "itrABC/recXYZ" }))
  const ids: string[] = []
  for await (const r of kit.paginate(conn, "records.list", { ...where, fields: ["Name"], pageSize: 5000 })) ids.push(r.id)
  assert.deepEqual(ids, ["rec1", "rec2"])
  assert.equal(calls[0]!.url.searchParams.get("pageSize"), "100")
  assert.equal(calls[1]!.url.searchParams.get("offset"), "itrABC/recXYZ")
  assert.deepEqual(calls[1]!.url.searchParams.getAll("fields[]"), ["Name"])
})

test("bases.list pages by offset and sends no page-size parameter (the endpoint has none)", async () => {
  const { conn, calls } = harness(airtable, () => json({ bases: [{ id: "appX", name: "Work" }], offset: "O2" }))
  const page = await conn.execute("bases.list", { pageSize: 50 })
  assert.equal(page.nextCursor, "O2")
  assert.equal(calls[0]!.url.search, "")
  assert.equal(calls[0]!.url.pathname, "/v0/meta/bases")
})

test("cell values of any type come back (numbers, arrays, objects)", async () => {
  const { conn } = harness(airtable, () => json({ id: "rec9", createdTime: "t", fields: { Count: 3, Done: true, Owner: { id: "usr1", email: "a@b.dev" } } }))
  const r = await conn.execute("records.get", { ...where, recordId: "rec9" })
  assert.equal(r.fields.Count, 3)
})

test("records.create uses the single-record form: { fields } at the top level, ids only in the path", async () => {
  const { conn, calls } = harness(airtable, () => json(rec))
  await conn.execute("records.create", { ...where, fields: { Name: "Ship it" }, typecast: true })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/v0/appX/Tasks")
  assert.deepEqual(calls[0]!.body, { fields: { Name: "Ship it" }, typecast: true })
})

test("records.update is a PATCH (partial) and is retried; it is never a PUT (which would clear other fields)", async () => {
  let n = 0
  const { conn, calls } = harness(airtable, () => (++n === 1 ? json({}, 503) : json(rec)), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("records.update", { ...where, recordId: "rec1", fields: { Status: "Done" } })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, "PATCH")
  assert.equal(calls[1]!.url.pathname, "/v0/appX/Tasks/rec1")
  assert.deepEqual(calls[1]!.body, { fields: { Status: "Done" } })
})

test("records.delete is a destructive DELETE and returns the id", async () => {
  const { conn, calls } = harness(airtable, () => json({ id: "rec1", deleted: true }))
  assert.deepEqual(await conn.execute("records.delete", { ...where, recordId: "rec1" }), { id: "rec1", deleted: true })
  assert.equal(calls[0]!.init.method, "DELETE")
  assert.equal(airtable.actions["records.delete"].effect, "destructive")
})

test("an invalid filter formula (HTTP 422) is invalid_input, not a crash", async () => {
  const { conn } = harness(airtable, () => json({ error: { type: "INVALID_FILTER_BY_FORMULA", message: "bad formula" } }, 422))
  await assert.rejects(() => conn.execute("records.list", { ...where, filterByFormula: "{" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("OAuth: Airtable's endpoints, Basic client auth, and PKCE left on", () => {
  assert.equal(airtable.auth.type, "oauth2")
  if (airtable.auth.type === "oauth2") {
    assert.equal(airtable.auth.authorizeUrl, "https://airtable.com/oauth2/v1/authorize")
    assert.equal(airtable.auth.tokenUrl, "https://airtable.com/oauth2/v1/token")
    assert.equal(airtable.auth.clientAuth, "basic")
    assert.notEqual(airtable.auth.pkce, false)
  }
})
