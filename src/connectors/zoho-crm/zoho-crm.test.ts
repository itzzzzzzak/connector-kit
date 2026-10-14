import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import zohoCrm from "./index.js"

const connect = { variables: { region: "com" }, credentials: { token: "1000.abcdef.123456" } }
const h = (respond: Parameters<typeof harness>[1], region = "com") => harness(zohoCrm, respond, { ...connect, variables: { region } })
const ID = "4150868000001234567"
const lead = { id: ID, Last_Name: "Lovelace", Email: "ada@acme.dev" }
const page = (records: unknown[], info: Record<string, unknown> = {}) => ({ data: records, info: { per_page: 50, count: records.length, page: 1, more_records: false, ...info } })
const saved = (code = "SUCCESS", status = "success") => ({ data: [{ code, status, message: "record added", details: { id: ID } }] })
type Page = { items: unknown[]; nextCursor: string | null }

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(zohoCrm, { ...c, connect })
std({ action: "records.list", input: { module: "Leads", fields: ["Last_Name"] }, ok: page([lead]), badInput: { module: "Leads", fields: "Last_Name" } })
std({ action: "records.search", input: { module: "Leads", email: "ada@acme.dev" }, ok: page([lead]), badInput: { module: "Leads", email: 5 } })
std({ action: "record.get", input: { module: "Leads", id: ID }, ok: { data: [lead] }, badInput: { module: "Leads", id: "../x" } })
std({ action: "coql.query", input: { query: "select Last_Name from Leads limit 5" }, ok: page([lead]), badInput: { query: "" } })
std({ action: "record.create", input: { module: "Leads", fields: { Last_Name: "Lovelace" } }, ok: saved(), badInput: { module: "Leads", fields: "Lovelace" } })
std({ action: "record.update", input: { module: "Leads", id: ID, fields: { Email: "ada@acme.dev" } }, ok: saved("SUCCESS"), badInput: { module: "Leads", id: ID, fields: {} } })
std({ action: "record.delete", input: { module: "Leads", id: ID }, ok: saved(), badInput: { module: "Leads", id: "" } })
std({ action: "modules.list", input: {}, ok: { modules: [{ api_name: "Leads", plural_label: "Leads", api_supported: true, creatable: true }] } })
std({ action: "fields.list", input: { module: "Leads" }, ok: { fields: [{ api_name: "Last_Name", data_type: "text", system_mandatory: true }] }, badInput: { module: "Le ads" } })

test("calls go to the region's zohoapis host with the Zoho-oauthtoken header, not Bearer", async () => {
  const { conn, calls } = h(() => json(page([lead])))
  await conn.execute("records.list", { module: "Leads", fields: ["Last_Name", "Email"] })
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, "https://www.zohoapis.com/crm/v8/Leads")
  assert.equal(calls[0]!.header("authorization"), "Zoho-oauthtoken 1000.abcdef.123456")
})

test("every declared region builds its own zohoapis host", async () => {
  const hosts: Record<string, string> = { com: "www.zohoapis.com", eu: "www.zohoapis.eu", in: "www.zohoapis.in", "com.au": "www.zohoapis.com.au", jp: "www.zohoapis.jp", ca: "www.zohoapis.ca", sa: "www.zohoapis.sa", "com.cn": "www.zohoapis.com.cn" }
  assert.deepEqual(Object.keys(hosts).sort(), [...zohoCrm.variables!["region"]!.values!].sort())
  for (const [region, host] of Object.entries(hosts)) {
    const { conn, calls } = h(() => json({ modules: [] }), region)
    await conn.execute("modules.list", {})
    assert.equal(calls[0]!.url.hostname, host, region)
  }
})

test("a region that could send the token to another host is refused", () => {
  for (const region of ["evil.com", "com/", "com.evil.com", "", "COM", "com:8080", "x@evil.com", "com#"]) {
    assert.throws(() => h(() => json({}), region), /not valid/, region)
  }
})

test("records.list sends the field list, sort and page size as Zoho's parameters", async () => {
  const { conn, calls } = h(() => json(page([lead])))
  await conn.execute("records.list", { module: "Leads", fields: ["Last_Name", "Email"], sortBy: "Modified_Time", sortOrder: "asc", pageSize: 25 })
  const q = calls[0]!.url.searchParams
  assert.equal(q.get("fields"), "Last_Name,Email")
  assert.equal(q.get("sort_by"), "Modified_Time")
  assert.equal(q.get("sort_order"), "asc")
  assert.equal(q.get("per_page"), "25")
})

test("records.list needs fields, at most 50 of them, and sortOrder needs sortBy; nothing is sent", async () => {
  const { conn, calls } = h(() => json(page([])))
  const fifty = Array.from({ length: 51 }, (_, i) => `F${i}`)
  for (const input of [{ module: "Leads" }, { module: "Leads", fields: [] }, { module: "Leads", fields: fifty }, { module: "Leads", fields: ["A"], sortOrder: "asc" }, { module: "Leads", fields: ["A"], pageSize: 500 }]) {
    await assert.rejects(() => conn.execute("records.list", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(calls.length, 0)
})

test("list paging goes page by page, keeps the filters, and ends when more_records is false", async () => {
  const { conn, calls } = h((call) => json(call.url.searchParams.get("page") === "2" ? page([lead], { page: 2 }) : page([lead], { more_records: true })))
  const first = (await conn.execute("records.list", { module: "Leads", fields: ["Last_Name"], pageSize: 50 })) as Page
  assert.equal(first.nextCursor, "p:2")
  const second = (await conn.execute("records.list", { module: "Leads", fields: ["Last_Name"], pageSize: 50, cursor: first.nextCursor! })) as Page
  assert.equal(calls[1]!.url.searchParams.get("page"), "2")
  assert.equal(calls[1]!.url.searchParams.get("fields"), "Last_Name")
  assert.equal(calls[1]!.url.searchParams.get("per_page"), "50")
  assert.equal(second.nextCursor, null)
})

test("after the first 2,000 records paging continues with the page token, which replaces the page number", async () => {
  const { conn, calls } = h((call) => (call.url.searchParams.has("page_token") ? json(page([lead], { more_records: false })) : json(page([lead], { page: 10, per_page: 200, more_records: true, next_page_token: "tok_123.abc" }))))
  const input = { module: "Leads", fields: ["Last_Name"], pageSize: 200 }
  const last = (await conn.execute("records.list", { ...input, cursor: "p:10" })) as Page
  assert.equal(last.nextCursor, "t:tok_123.abc")
  await conn.execute("records.list", { ...input, cursor: last.nextCursor! })
  assert.equal(calls[1]!.url.searchParams.get("page_token"), "tok_123.abc")
  assert.equal(calls[1]!.url.searchParams.has("page"), false)
})

test("paging stops at the 2,000 window when Zoho gives no page token", async () => {
  const { conn } = h(() => json(page([lead], { page: 10, per_page: 200, more_records: true })))
  const result = (await conn.execute("records.list", { module: "Leads", fields: ["Last_Name"], pageSize: 200, cursor: "p:10" })) as Page
  assert.equal(result.nextCursor, null)
})

test("a cursor this connector did not produce is refused before anything is sent", async () => {
  const { conn, calls } = h(() => json(page([])))
  for (const cursor of ["2", "p:0", "p:2&fields=x", "t:", "t:a b", "https://evil.com/x", "//evil.com"]) {
    await assert.rejects(() => conn.execute("records.list", { module: "Leads", fields: ["A"], cursor }), (e: unknown) => (e as { code?: string }).code === "invalid_input", cursor)
  }
  assert.equal(calls.length, 0)
})

test("an empty 204 answer is an empty page, for a list and for a search", async () => {
  const { conn } = h(() => new Response(null, { status: 204 }))
  assert.deepEqual(await conn.execute("records.list", { module: "Leads", fields: ["Last_Name"] }), { items: [], nextCursor: null })
  assert.deepEqual(await conn.execute("records.search", { module: "Leads", word: "nobody" }), { items: [], nextCursor: null })
  assert.deepEqual(await conn.execute("coql.query", { query: "select Last_Name from Leads where Last_Name = 'zzz' limit 5" }), { data: [] })
})

test("records.search sends exactly one mode and pages with page and per_page", async () => {
  const { conn, calls } = h((call) => json(call.url.searchParams.get("page") === "2" ? page([lead]) : page([lead], { more_records: true })))
  const first = (await conn.execute("records.search", { module: "Contacts", criteria: "(Last_Name:equals:Smith) and (Email:starts_with:a)", pageSize: 1 })) as Page
  assert.equal(calls[0]!.url.pathname, "/crm/v8/Contacts/search")
  assert.equal(calls[0]!.url.searchParams.get("criteria"), "(Last_Name:equals:Smith) and (Email:starts_with:a)")
  assert.equal(calls[0]!.url.searchParams.has("email"), false)
  assert.equal(first.nextCursor, "2")
  await conn.execute("records.search", { module: "Contacts", criteria: "(Last_Name:equals:Smith)", pageSize: 1, cursor: first.nextCursor! })
  assert.equal(calls[1]!.url.searchParams.get("page"), "2")
  assert.equal(calls[1]!.url.searchParams.get("criteria"), "(Last_Name:equals:Smith)")
})

test("records.search needs exactly one of criteria, email, phone, word", async () => {
  const { conn, calls } = h(() => json(page([])))
  for (const input of [{ module: "Leads" }, { module: "Leads", email: "a@b.co", word: "x" }]) {
    await assert.rejects(() => conn.execute("records.search", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(calls.length, 0)
})

test("record.get returns the one record out of Zoho's data array, and fields is optional", async () => {
  const { conn, calls } = h(() => json({ data: [lead] }))
  assert.deepEqual(await conn.execute("record.get", { module: "Leads", id: ID, fields: ["Last_Name", "Email"] }), lead)
  assert.equal(calls[0]!.url.pathname, `/crm/v8/Leads/${ID}`)
  assert.equal(calls[0]!.url.searchParams.get("fields"), "Last_Name,Email")
  await conn.execute("record.get", { module: "Leads", id: ID })
  assert.equal(calls[1]!.url.search, "")
})

test("coql.query posts the statement as select_query", async () => {
  const { conn, calls } = h(() => json(page([lead])))
  await conn.execute("coql.query", { query: "select Last_Name from Leads limit 5" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/crm/v8/coql")
  assert.deepEqual(calls[0]!.body, { select_query: "select Last_Name from Leads limit 5" })
})

test("create, update and delete send Zoho's data envelope, and the id travels in the path", async () => {
  const create = h(() => json(saved(), 201))
  await create.conn.execute("record.create", { module: "Contacts", fields: { Last_Name: "Lovelace", Email: "ada@acme.dev" } })
  assert.equal(create.calls[0]!.init.method, "POST")
  assert.equal(create.calls[0]!.url.pathname, "/crm/v8/Contacts")
  assert.deepEqual(create.calls[0]!.body, { data: [{ Last_Name: "Lovelace", Email: "ada@acme.dev" }] })

  const update = h(() => json(saved()))
  await update.conn.execute("record.update", { module: "Contacts", id: ID, fields: { Title: "CTO" } })
  assert.equal(update.calls[0]!.init.method, "PUT")
  assert.equal(update.calls[0]!.url.pathname, `/crm/v8/Contacts/${ID}`)
  assert.deepEqual(update.calls[0]!.body, { data: [{ Title: "CTO" }] })

  const del = h(() => json(saved()))
  await del.conn.execute("record.delete", { module: "Contacts", id: ID })
  assert.equal(del.calls[0]!.init.method, "DELETE")
  assert.equal(del.calls[0]!.url.pathname, `/crm/v8/Contacts/${ID}`)
  assert.equal(del.calls[0]!.init.body, undefined)
})

test("fields.list passes the module as a query parameter", async () => {
  const { conn, calls } = h(() => json({ fields: [] }))
  await conn.execute("fields.list", { module: "Deals" })
  assert.equal(calls[0]!.url.pathname, "/crm/v8/settings/fields")
  assert.equal(calls[0]!.url.searchParams.get("module"), "Deals")
})

test("a per-record failure inside a 2xx answer fails the call: duplicate, invalid value, no permission", async () => {
  const entry = (code: string) => ({ data: [{ code, status: "error", message: "free text from Zoho that must not be echoed", details: {} }] })
  const dup = h(() => json(entry("DUPLICATE_DATA"), 202))
  await assert.rejects(() => dup.conn.execute("record.create", { module: "Leads", fields: { Email: "a@b.co" } }), (e: unknown) => {
    const err = e as { code?: string; message: string }
    return err.code === "invalid_input" && err.message.includes("duplicate_data") && !err.message.includes("free text")
  })
  const bad = h(() => json(entry("INVALID_DATA"), 207))
  await assert.rejects(() => bad.conn.execute("record.update", { module: "Leads", id: ID, fields: { Email: 1 } }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  const denied = h(() => json(entry("NO_PERMISSION"), 200))
  await assert.rejects(() => denied.conn.execute("record.delete", { module: "Leads", id: ID }), (e: unknown) => (e as { code?: string }).code === "forbidden")
})

test("a record that merely has a status field is not mistaken for a failure", async () => {
  const { conn } = h(() => json(page([{ id: ID, status: "error", code: "x", message: "a custom field called message" }])))
  const result = (await conn.execute("records.list", { module: "Leads", fields: ["status"] })) as Page
  assert.equal(result.items.length, 1)
})

test("Zoho's error codes are mapped: scope mismatch, too many requests, invalid data", async () => {
  const scope = h(() => json({ code: "OAUTH_SCOPE_MISMATCH", message: "invalid oauth scope to access this URL", status: "error", details: {} }, 401))
  await assert.rejects(() => scope.conn.execute("modules.list", {}), (e: unknown) => {
    const err = e as { code?: string; retryable?: boolean }
    return err.code === "forbidden" && err.retryable === false
  })
  const many = h(() => json({ code: "TOO_MANY_REQUESTS", message: "too many requests", status: "error", details: {} }, 400))
  await assert.rejects(() => many.conn.execute("modules.list", {}), (e: unknown) => (e as { code?: string }).code === "rate_limited")
  const invalid = h(() => json({ code: "INVALID_DATA", message: "the id given seems to be invalid", status: "error", details: {} }, 400))
  await assert.rejects(() => invalid.conn.execute("record.get", { module: "Leads", id: ID }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("record.delete is destructive, and the token is a Zoho-oauthtoken header", () => {
  assert.equal(zohoCrm.actions["record.delete"]!.effect, "destructive")
  assert.deepEqual(zohoCrm.auth, { type: "apiKey", header: "Authorization", prefix: "Zoho-oauthtoken " })
})
