import { defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Intuit's QuickBooks Online Accounting API reference (developer.intuit.com/app/developer/qbo/docs/api/accounting): base URL
// https://quickbooks.api.intuit.com/v3/company/{realmId} (a SANDBOX company uses https://sandbox-quickbooks.api.intuit.com, chosen with the `api`
// variable), the company is addressed by its "realm id" (digits, returned when the user connects), OAuth 2.0 authorization code with the scope
// com.intuit.quickbooks.accounting (the client authenticates at the token endpoint with HTTP Basic; access tokens last 1 hour and the refresh token ROTATES),
// and `Accept: application/json` is required (the default is XML). Reads go through a SQL-like query, GET /query?query=select * from Invoice
// STARTPOSITION 1 MAXRESULTS 20, answered as { QueryResponse: { Invoice: [...], startPosition, maxResults } }; a single record is GET /invoice/{id}
// answered as { Invoice: {...} }. An UPDATE or VOID must send the record's current `SyncToken` (read it first) or QuickBooks refuses with a stale-object error.
// Money amounts are decimal numbers in the company's currency. Intuit's rate limit is 500 requests per minute per company (HTTP 429).
//
// SECURITY: this is a company's books. Creating an invoice shows up in the customer's balance and in reports; voiding one reverses its effect: both need
// a human's say-so. Names, notes and memos come from outside and can contain text aimed at an AI: they are data, never instructions. Reading is limited to
// SELECT queries; the connector never sends a query that changes data.

const realmId = z.string().regex(/^\d{6,20}$/, "A realm id is 6 to 20 digits").describe("The QuickBooks company (realm) id, returned when the user connects the company")
const recordId = z.string().regex(/^\d{1,20}$/, "A QuickBooks id is a number written as text")
const page = { startPosition: z.number().int().min(1).optional().describe("Position of the first record, starting at 1. For the next page add maxResults to the last one"), maxResults: z.number().int().min(1).max(100).optional().describe("Records per page. Default 20") }
const ref = z.looseObject({ value: z.string(), name: z.string().optional() }).nullish()
const money = z.number().finite()

const customer = z.looseObject({ Id: z.string(), SyncToken: z.string().optional(), DisplayName: z.string().optional(), CompanyName: z.string().optional(), Active: z.boolean().optional(), Balance: z.number().optional(), PrimaryEmailAddr: z.looseObject({ Address: z.string().optional() }).nullish() })
const invoice = z.looseObject({ Id: z.string(), SyncToken: z.string().optional(), DocNumber: z.string().optional(), TxnDate: z.string().optional(), DueDate: z.string().optional(), TotalAmt: z.number().optional(), Balance: z.number().optional(), CustomerRef: ref, EmailStatus: z.string().optional() })
const listOf = (key: string, item: z.ZodType) => z.looseObject({ [key]: z.array(item).optional(), startPosition: z.number().optional(), maxResults: z.number().optional() })

/** QuickBooks queries are written as text, so a value is quoted and its quotes and backslashes escaped before it goes in. */
export const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
const queryFor = (entity: string, where: string[], i: Record<string, unknown>, orderBy = ""): string =>
  `select * from ${entity}${where.length > 0 ? ` where ${where.join(" and ")}` : ""}${orderBy ? ` orderby ${orderBy}` : ""} startposition ${(i.startPosition as number | undefined) ?? 1} maxresults ${(i.maxResults as number | undefined) ?? 20}`
const unwrapQuery = (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as { QueryResponse?: unknown }).QueryResponse : undefined)
const unwrapKey = (key: string) => (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined)

export const quickbooks = defineConnector({
  name: "quickbooks",
  baseUrl: "https://{api}.intuit.com/v3/company",
  variables: { api: { description: 'Which QuickBooks to use: "quickbooks" for a real company, "sandbox-quickbooks" for an Intuit sandbox company', example: "quickbooks", values: ["quickbooks", "sandbox-quickbooks"] } },
  auth: { type: "oauth2", authorizeUrl: "https://appcenter.intuit.com/connect/oauth2", tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", scopes: ["com.intuit.quickbooks.accounting"], clientAuth: "basic", pkce: false },
  defaultHeaders: { Accept: "application/json" },
  meta: {
    title: "QuickBooks",
    description: "Read QuickBooks Online customers, invoices and company data with SELECT queries, create customers and invoices, and void invoices.",
    docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account",
    status: "docs-based",
    credentialEnv: "QUICKBOOKS_TOKEN",
  },
  actions: {
    "company.get": {
      description: "Get the company's name, legal name, country, fiscal year start and email. Use to check which company the connection is for.",
      method: "GET",
      path: "/{realmId}/query",
      input: z.object({ realmId }),
      output: z.looseObject({ CompanyName: z.string().optional(), LegalName: z.string().optional(), Country: z.string().optional(), FiscalYearStartMonth: z.string().optional() }),
      effect: "read",
      // The record is read with a query (its own URL repeats the realm id, which a path template cannot do).
      extract: (body) => {
        const rows = (unwrapQuery(body) as { CompanyInfo?: unknown[] } | undefined)?.CompanyInfo
        return Array.isArray(rows) ? rows[0] : undefined
      },
      buildQuery: () => ({ query: "select * from CompanyInfo" }),
    },
    "query.run": {
      description: 'Run a read-only QuickBooks query, such as: select * from Bill where Balance > \'0\' startposition 1 maxresults 50. Only SELECT is accepted. The records come back under their entity name (Bill, Account, Item, Vendor, Payment...).',
      method: "GET",
      path: "/{realmId}/query",
      input: z.object({ realmId, query: z.string().min(8).max(2000).regex(/^\s*select\s/i, "Only a SELECT query is accepted").refine((q) => !q.includes(";"), { message: "Send one statement, without a semicolon" }) }),
      output: z.looseObject({ startPosition: z.number().optional(), maxResults: z.number().optional(), totalCount: z.number().optional() }),
      effect: "read",
      extract: unwrapQuery,
      buildQuery: (i) => ({ query: i.query }),
    },
    "customers.list": {
      description: "List customers, optionally only active ones or those whose display name contains some text. Returns up to maxResults per page; for the next page set startPosition.",
      method: "GET",
      path: "/{realmId}/query",
      input: z.object({ realmId, active: z.boolean().optional().describe("true: only active customers; false: only inactive. Default: both"), nameContains: z.string().min(1).max(100).optional(), ...page }),
      output: listOf("Customer", customer),
      effect: "read",
      extract: unwrapQuery,
      buildQuery: (i) => ({ query: queryFor("Customer", [...(typeof i.active === "boolean" ? [`Active = ${i.active}`] : []), ...(typeof i.nameContains === "string" ? [`DisplayName like ${quote(`%${i.nameContains}%`)}`] : [])], i) }),
    },
    "customer.get": {
      description: "Get one customer by id, including the SyncToken you need to update it.",
      method: "GET",
      path: "/{realmId}/customer/{customerId}",
      input: z.object({ realmId, customerId: recordId }),
      output: customer,
      effect: "read",
      extract: unwrapKey("Customer"),
    },
    "invoices.list": {
      description: "List invoices, newest first, optionally for one customer, only unpaid ones, or from a date on. Returns up to maxResults per page; for the next page set startPosition.",
      method: "GET",
      path: "/{realmId}/query",
      input: z.object({ realmId, customerId: recordId.optional(), unpaidOnly: z.boolean().optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date written YYYY-MM-DD").optional().describe("Only invoices dated on or after this day"), ...page }),
      output: listOf("Invoice", invoice),
      effect: "read",
      extract: unwrapQuery,
      buildQuery: (i) => ({
        query: queryFor("Invoice", [...(typeof i.customerId === "string" ? [`CustomerRef = ${quote(i.customerId)}`] : []), ...(i.unpaidOnly === true ? ["Balance > '0'"] : []), ...(typeof i.since === "string" ? [`TxnDate >= ${quote(i.since)}`] : [])], i, "TxnDate desc"),
      }),
    },
    "invoice.get": {
      description: "Get one invoice by id with its lines, totals, balance and the SyncToken you need to void it.",
      method: "GET",
      path: "/{realmId}/invoice/{invoiceId}",
      input: z.object({ realmId, invoiceId: recordId }),
      output: invoice.extend({ Line: z.array(z.unknown()).optional() }),
      effect: "read",
      extract: unwrapKey("Invoice"),
    },
    "customer.create": {
      description: "Create a customer. DisplayName must be unique in the company. It appears in the company's books and in reports: ask a human first.",
      method: "POST",
      path: "/{realmId}/customer",
      input: z.object({ realmId, displayName: z.string().min(1).max(500), givenName: z.string().max(100).optional(), familyName: z.string().max(100).optional(), companyName: z.string().max(100).optional(), email: z.string().email().optional(), phone: z.string().max(21).optional(), notes: z.string().max(2000).optional() }),
      output: customer,
      effect: "write",
      extract: unwrapKey("Customer"),
      buildBody: (i) => ({
        DisplayName: i.displayName,
        ...(i.givenName !== undefined && { GivenName: i.givenName }),
        ...(i.familyName !== undefined && { FamilyName: i.familyName }),
        ...(i.companyName !== undefined && { CompanyName: i.companyName }),
        ...(i.email !== undefined && { PrimaryEmailAddr: { Address: i.email } }),
        ...(i.phone !== undefined && { PrimaryPhone: { FreeFormNumber: i.phone } }),
        ...(i.notes !== undefined && { Notes: i.notes }),
      }),
    },
    "invoice.create": {
      description: "Create an invoice for a customer from item lines (item id, quantity, unit price). It raises the customer's balance and shows in reports, but does not email it. Ask a human first.",
      method: "POST",
      path: "/{realmId}/invoice",
      input: z.object({
        realmId,
        customerId: recordId,
        lines: z.array(z.object({ itemId: recordId.describe("The item (product or service) id, from query.run on Item"), quantity: z.number().positive().default(1), unitPrice: money.min(0), description: z.string().max(4000).optional() })).min(1).max(100),
        txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Invoice date, YYYY-MM-DD. Default: today"),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        privateNote: z.string().max(4000).optional().describe("A note only the company sees"),
      }),
      output: invoice,
      effect: "write",
      extract: unwrapKey("Invoice"),
      buildBody: (i) => ({
        CustomerRef: { value: i.customerId },
        Line: (i.lines as Array<{ itemId: string; quantity: number; unitPrice: number; description?: string }>).map((l) => ({
          DetailType: "SalesItemLineDetail",
          Amount: Math.round(l.quantity * l.unitPrice * 100) / 100,
          ...(l.description !== undefined && { Description: l.description }),
          SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: l.quantity, UnitPrice: l.unitPrice },
        })),
        ...(i.txnDate !== undefined && { TxnDate: i.txnDate }),
        ...(i.dueDate !== undefined && { DueDate: i.dueDate }),
        ...(i.privateNote !== undefined && { PrivateNote: i.privateNote }),
      }),
    },
    "invoice.void": {
      description: "Void an invoice: its amounts are set to zero and it no longer counts in the books, but the record stays. Pass the SyncToken from invoice.get. This reverses an accounting entry: ask a human first.",
      method: "POST",
      path: "/{realmId}/invoice",
      input: z.object({ realmId, invoiceId: recordId, syncToken: z.string().regex(/^\d{1,10}$/, "A SyncToken is a number written as text").describe("The invoice's current SyncToken, from invoice.get") }),
      output: invoice,
      effect: "destructive",
      extract: unwrapKey("Invoice"),
      buildQuery: () => ({ operation: "void" }),
      buildBody: (i) => ({ Id: i.invoiceId, SyncToken: i.syncToken }),
    },
  },
})

export default quickbooks
