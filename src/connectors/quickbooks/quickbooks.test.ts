import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import quickbooks, { quote } from "./index.js"

const connect = { variables: { api: "quickbooks" }, credentials: { token: "eyJ.ACCESS" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(quickbooks, respond, connect)
const std = (c: Parameters<typeof standardTests>[1]) => standardTests(quickbooks, { ...c, connect })
const realm = "9130350000000000"
const customer = { Id: "58", SyncToken: "0", DisplayName: "Amy's Bird Sanctuary", Active: true, Balance: 239 }
const invoice = { Id: "130", SyncToken: "2", DocNumber: "1037", TxnDate: "2026-10-01", TotalAmt: 362.07, Balance: 362.07, CustomerRef: { value: "58", name: "Amy" } }
const q = (key: string, rows: unknown[]) => ({ QueryResponse: { [key]: rows, startPosition: 1, maxResults: rows.length }, time: "2026-10-13T00:00:00.000-07:00" })

std({ action: "company.get", input: { realmId: realm }, ok: q("CompanyInfo", [{ CompanyName: "Acme", Country: "US" }]), badInput: { realmId: "abc" } })
std({ action: "query.run", input: { realmId: realm, query: "select * from Item" }, ok: q("Item", [{ Id: "1", Name: "Hours" }]), badInput: { realmId: realm, query: "delete from Customer" } })
std({ action: "customers.list", input: { realmId: realm }, ok: q("Customer", [customer]), badInput: { realmId: realm, maxResults: 5000 } })
std({ action: "customer.get", input: { realmId: realm, customerId: "58" }, ok: { Customer: customer }, badInput: { realmId: realm, customerId: "x" } })
std({ action: "invoices.list", input: { realmId: realm }, ok: q("Invoice", [invoice]), badInput: { realmId: realm, since: "last week" } })
std({ action: "invoice.get", input: { realmId: realm, invoiceId: "130" }, ok: { Invoice: invoice }, badInput: { realmId: realm, invoiceId: "" } })
std({ action: "customer.create", input: { realmId: realm, displayName: "New Co" }, ok: { Customer: customer }, badInput: { realmId: realm, displayName: "" } })
std({ action: "invoice.create", input: { realmId: realm, customerId: "58", lines: [{ itemId: "1", unitPrice: 100 }] }, ok: { Invoice: invoice }, badInput: { realmId: realm, customerId: "58", lines: [] } })
std({ action: "invoice.void", input: { realmId: realm, invoiceId: "130", syncToken: "2" }, ok: { Invoice: invoice }, badInput: { realmId: realm, invoiceId: "130", syncToken: "latest" } })

test("the sandbox variable picks the sandbox host, and the real one is the default choice", async () => {
  const sandbox = harness(quickbooks, () => json(q("CompanyInfo", [{ CompanyName: "Acme" }])), { ...connect, variables: { api: "sandbox-quickbooks" } })
  await sandbox.conn.execute("company.get", { realmId: realm })
  assert.equal(sandbox.calls[0]!.url.host, "sandbox-quickbooks.intuit.com")
  assert.equal(sandbox.calls[0]!.url.pathname, `/v3/company/${realm}/query`)
  assert.equal(sandbox.calls[0]!.header("accept"), "application/json")
})

test("a variable outside the closed list is refused", () => {
  assert.throws(() => harness(quickbooks, () => json({}), { ...connect, variables: { api: "evil" } }))
})

test("customers.list builds a quoted, paged query and unwraps QueryResponse", async () => {
  const { conn, calls } = h(() => json(q("Customer", [customer])))
  const out = (await conn.execute("customers.list", { realmId: realm, active: true, nameContains: "O'Neil", startPosition: 21, maxResults: 20 })) as { Customer: unknown[] }
  assert.equal(out.Customer.length, 1)
  assert.equal(calls[0]!.url.searchParams.get("query"), "select * from Customer where Active = true and DisplayName like '%O\\'Neil%' startposition 21 maxresults 20")
})

test("invoices.list orders newest first and filters by customer, balance and date", async () => {
  const { conn, calls } = h(() => json(q("Invoice", [invoice])))
  await conn.execute("invoices.list", { realmId: realm, customerId: "58", unpaidOnly: true, since: "2026-09-01" })
  assert.equal(calls[0]!.url.searchParams.get("query"), "select * from Invoice where CustomerRef = '58' and Balance > '0' and TxnDate >= '2026-09-01' orderby TxnDate desc startposition 1 maxresults 20")
})

test("quote escapes quotes and backslashes", () => {
  assert.equal(quote("a'b\\c"), "'a\\'b\\\\c'")
})

test("query.run takes one SELECT only", async () => {
  const { conn, calls } = h(() => json(q("Item", [])))
  await assert.rejects(() => conn.execute("query.run", { realmId: realm, query: "select * from Item; select * from Bill" }), /one statement/i)
  assert.equal(calls.length, 0)
  await conn.execute("query.run", { realmId: realm, query: "select * from Item where Active = true" })
  assert.equal(calls.length, 1)
})

test("an invoice is posted with computed line amounts and item references", async () => {
  const { conn, calls } = h(() => json({ Invoice: invoice }))
  await conn.execute("invoice.create", { realmId: realm, customerId: "58", dueDate: "2026-11-01", lines: [{ itemId: "7", quantity: 3, unitPrice: 19.99, description: "Hours" }] })
  assert.equal(calls[0]!.url.pathname, `/v3/company/${realm}/invoice`)
  assert.deepEqual(calls[0]!.body, { CustomerRef: { value: "58" }, DueDate: "2026-11-01", Line: [{ DetailType: "SalesItemLineDetail", Amount: 59.97, Description: "Hours", SalesItemLineDetail: { ItemRef: { value: "7" }, Qty: 3, UnitPrice: 19.99 } }] })
})

test("voiding sends operation=void in the query and the id with its SyncToken in the body", async () => {
  const { conn, calls } = h(() => json({ Invoice: invoice }))
  await conn.execute("invoice.void", { realmId: realm, invoiceId: "130", syncToken: "2" })
  assert.equal(calls[0]!.url.searchParams.get("operation"), "void")
  assert.deepEqual(calls[0]!.body, { Id: "130", SyncToken: "2" })
  assert.equal(quickbooks.actions["invoice.void"].effect, "destructive")
})
