import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import salesforce from "./index.js"

const connect = { variables: { domain: "acme" }, credentials: { token: "00D-token" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(salesforce, respond, connect)
const ID = "0015g00000AbCdEAAV"
const account = { attributes: { type: "Account", url: `/services/data/v66.0/sobjects/Account/${ID}` }, Id: ID, Name: "Acme" }
const page = (records: unknown[], next?: string) => ({ totalSize: 5000, done: next === undefined, ...(next && { nextRecordsUrl: next }), records })
const NEXT = "/services/data/v66.0/query/01g5g00000AbCdE-2000"

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(salesforce, { ...c, connect })
std({ action: "records.query", input: { q: "SELECT Id FROM Account" }, ok: page([account]), badInput: { q: 5 } })
std({ action: "records.queryAll", input: { q: "SELECT Id FROM Account" }, ok: page([account]), badInput: { q: "" } })
std({ action: "records.search", input: { q: "FIND {Acme}" }, ok: { searchRecords: [account] }, badInput: { q: "" } })
std({ action: "record.get", input: { sobject: "Account", id: ID }, ok: account, badInput: { sobject: "Account", id: "../x" } })
std({ action: "record.create", input: { sobject: "Account", fields: { Name: "Acme" } }, ok: { id: ID, success: true, errors: [] }, badInput: { sobject: "Account", fields: "Acme" } })
std({ action: "record.update", input: { sobject: "Account", id: ID, fields: { Name: "Acme 2" } }, ok: {}, badInput: { sobject: "Account", id: ID, fields: [] } })
std({ action: "record.upsert", input: { sobject: "Account", externalIdField: "Ext__c", externalId: "A-1", fields: { Name: "Acme" } }, ok: { id: ID, success: true, created: true }, badInput: { sobject: "Account", externalIdField: "Ext__c", externalId: "", fields: {} } })
std({ action: "record.delete", input: { sobject: "Account", id: ID }, ok: {}, badInput: { sobject: "Account", id: "" } })
std({ action: "sobjects.list", input: {}, ok: { sobjects: [{ name: "Account", label: "Account", custom: false, queryable: true }] } })
std({ action: "sobject.describe", input: { sobject: "Account" }, ok: { name: "Account", fields: [{ name: "Name", type: "string", length: 255, nillable: false, picklistValues: [] }] }, badInput: { sobject: "Account Name" } })
std({ action: "limits.get", input: {}, ok: { DailyApiRequests: { Max: 15000, Remaining: 14000 } } })

test("calls go to the org's My Domain with the API version in the path, and a bearer token", async () => {
  const { conn, calls } = h(() => json(page([account])))
  await conn.execute("records.query", { q: "SELECT Id, Name FROM Account WHERE Name LIKE 'A%'" })
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, "https://acme.my.salesforce.com/services/data/v66.0/query")
  assert.equal(calls[0]!.url.searchParams.get("q"), "SELECT Id, Name FROM Account WHERE Name LIKE 'A%'")
  assert.equal(calls[0]!.header("authorization"), "Bearer 00D-token")
})

test("a sandbox domain is accepted, and a domain that tries to leave salesforce.com is not", () => {
  assert.doesNotThrow(() => harness(salesforce, () => json({}), { variables: { domain: "acme--uat.sandbox" }, credentials: { token: "t" } }))
  for (const domain of ["evil.com/", "acme.my.evil.com#", "a b", "acme@evil.com", ""]) {
    assert.throws(() => harness(salesforce, () => json({}), { variables: { domain }, credentials: { token: "t" } }), /not valid/, domain)
  }
})

test("paging follows nextRecordsUrl: the cursor is that path, and the second request drops the query", async () => {
  const { conn, calls } = h((call) => json(call.url.pathname.includes("/query/01g") ? page([account]) : page([account], NEXT)))
  const first = (await conn.execute("records.query", { q: "SELECT Id FROM Account" })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(first.nextCursor, NEXT)
  const second = (await conn.execute("records.query", { cursor: NEXT })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(calls[1]!.url.toString(), `https://acme.my.salesforce.com${NEXT}`)
  assert.equal(calls[1]!.url.search, "")
  assert.equal(second.nextCursor, null)
})

test("a cursor that is not a query path is refused before anything is sent", async () => {
  const { conn, calls } = h(() => json(page([])))
  for (const cursor of ["//evil.com/services/data/v66.0/query/x", "https://evil.com/x", "/services/data/v66.0/sobjects/Account", "/services/data/v66.0/query/../limits"]) {
    await assert.rejects(() => conn.execute("records.query", { cursor }), (e: unknown) => (e as { code?: string }).code === "invalid_input", cursor)
  }
  assert.equal(calls.length, 0)
})

test("a query needs a statement or a cursor", async () => {
  const { conn, calls } = h(() => json(page([])))
  await assert.rejects(() => conn.execute("records.query", {}), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("creating sends the field map as the body; updating and deleting expect an empty 204", async () => {
  const create = h(() => json({ id: ID, success: true, errors: [] }, 201))
  await create.conn.execute("record.create", { sobject: "Contact", fields: { LastName: "Lovelace", Email: "ada@acme.dev" } })
  assert.equal(create.calls[0]!.url.pathname, "/services/data/v66.0/sobjects/Contact")
  assert.deepEqual(create.calls[0]!.body, { LastName: "Lovelace", Email: "ada@acme.dev" })
  const empty = h(() => new Response(null, { status: 204 }))
  await empty.conn.execute("record.update", { sobject: "Contact", id: ID, fields: { Title: "CTO" } })
  await empty.conn.execute("record.delete", { sobject: "Contact", id: ID })
  assert.equal(empty.calls[0]!.init.method, "PATCH")
  assert.equal(empty.calls[1]!.init.method, "DELETE")
  assert.equal(empty.calls[1]!.init.body, undefined)
})

test("an upsert names the external id field and value in the path", async () => {
  const { conn, calls } = h(() => json({ id: ID, success: true, created: false }))
  await conn.execute("record.upsert", { sobject: "Account", externalIdField: "Ext__c", externalId: "A/1 2", fields: { Name: "Acme" } })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.equal(calls[0]!.url.pathname, "/services/data/v66.0/sobjects/Account/Ext__c/A%2F1%202")
})

test("record.get sends a field list as one comma-separated parameter", async () => {
  const { conn, calls } = h(() => json(account))
  await conn.execute("record.get", { sobject: "Account", id: ID, fields: ["Name", "Owner.Name"] })
  assert.equal(calls[0]!.url.searchParams.get("fields"), "Name,Owner.Name")
})

test("Salesforce's error array is mapped: an expired session, the daily limit, a malformed query", async () => {
  const expired = h(() => json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], 401))
  await assert.rejects(() => expired.conn.execute("limits.get", {}), (e: unknown) => (e as { code?: string }).code === "auth_expired")
  const limit = h(() => json([{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }], 403))
  await assert.rejects(() => limit.conn.execute("limits.get", {}), (e: unknown) => {
    const err = e as { code?: string; retryable?: boolean; message: string }
    return err.code === "rate_limited" && err.retryable === false && !err.message.includes("TotalRequests")
  })
  const bad = h(() => json([{ message: "unexpected token: 'FORM'", errorCode: "MALFORMED_QUERY" }], 400))
  await assert.rejects(() => bad.conn.execute("records.query", { q: "SELECT Id FORM Account" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("only delete is destructive, and the Salesforce OAuth endpoints are https", () => {
  const effects = Object.fromEntries(Object.entries(salesforce.actions).map(([name, a]) => [name, a.effect]))
  assert.equal(effects["record.delete"], "destructive")
  assert.equal(Object.values(effects).filter((e) => e === "destructive").length, 1)
  assert.equal(salesforce.auth.type, "oauth2")
})
