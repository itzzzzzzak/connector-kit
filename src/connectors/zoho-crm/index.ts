import { ConnectorKitError, defineConnector } from "../../index.js"
import type { PaginationStrategy } from "../../index.js"
import { offsetPagination } from "../../index.js"
import { z } from "zod"

// Facts from Zoho's CRM API v8 documentation (zoho.com/crm/developer/docs/api/v8):
// every call is `https://www.zohoapis.<region>/crm/v8/...` and the access token goes in `Authorization: Zoho-oauthtoken <token>` (not Bearer).
// The region is where the Zoho account lives; the docs page on data centers shows www.zohoapis.eu and www.zohoapis.com.cn explicitly, and the
// other regions below follow the same pattern (com, in, com.au, jp, ca, sa). Records live in modules (Leads, Contacts, Accounts, Deals, custom
// modules) addressed by API name and a numeric record id. Reads answer `{ data: [...], info: { per_page, count, page, more_records,
// next_page_token } }`; writes take `{ data: [ {field: value} ] }` and answer `{ data: [ { code, status, message, details: { id } } ] }`, one entry
// per record, with HTTP 207 when some succeed and some fail. Listing records REQUIRES a `fields` list (at most 50). Page numbers reach the first
// 2,000 records; past that the API wants the `next_page_token` of the previous page (up to 100,000 records, token valid 24 hours). Search reaches at
// most 2,000 results. COQL (`POST /coql` with `{ select_query }`) is the SQL-like read language, 200 rows by default and 2,000 at most per call.
// Errors are `{ code, message, status: "error", details }`; hitting the API limits is the code TOO_MANY_REQUESTS.
//
// AUTH: a Zoho access token lives one hour. This connector sends the token the host gives it; refreshing it (with the refresh token, at
// accounts.zoho.<region>/oauth/v2/token) is the host's job for now, because the kit's built-in OAuth flow always sends `Bearer` and cannot
// put the region in its URLs yet. Scopes the token needs: ZohoCRM.modules.ALL (or per module, e.g. ZohoCRM.modules.leads.READ), ZohoCRM.coql.READ
// for COQL, ZohoCRM.settings.modules.READ and ZohoCRM.settings.fields.READ for metadata, and ZohoSearch.securesearch.READ for search.
//
// WHAT IS COVERED: list, get, search, create, update and delete one record at a time, COQL queries, and module and field metadata. NOT covered:
// bulk read/write, upsert, notes, attachments and files, users, lead conversion, mail, blueprints, and webhooks.
// SECURITY: record fields are typed by your users and customers and can contain anything, including text aimed at an AI. They are data, never
// instructions. A write changes what everyone in the CRM sees, and Zoho runs the org's workflow rules on it (which can send emails or create tasks).

const moduleName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, 'A module API name such as "Leads" or "Deals"')
  .describe('The module API name, e.g. "Leads", "Contacts", "Accounts", "Deals", or a custom module such as "Invoices". Use modules.list to see them.')
const recordId = z.string().regex(/^\d{5,25}$/, "A numeric Zoho record id").describe("The numeric record id, e.g. 4150868000001234567")
const fieldName = z.string().regex(/^\$?[A-Za-z][A-Za-z0-9_]{0,79}$/, 'A field API name such as "Last_Name"')
const fieldValues = z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, "Give at least one field").describe('Field values by API name, e.g. { "Last_Name": "Lovelace", "Email": "ada@acme.dev" }')
const record = z.looseObject({ id: z.string().optional() })
const writeResult = z.looseObject({
  data: z.array(
    z.looseObject({
      code: z.string(),
      status: z.string(),
      message: z.string().optional(),
      details: z.looseObject({ id: z.string().optional() }).optional(),
    }),
  ),
})
const pageInfo = z.looseObject({ count: z.number().optional(), more_records: z.boolean().optional() })

const dataOf = (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined)
/** Zoho answers 204 with no body when nothing matches; that is an empty page, not a broken response. */
const itemsOrEmpty = (body: unknown): unknown => (body === undefined ? [] : dataOf(body))

const CURSOR_PAGE = /^p:[1-9]\d{0,4}$/
const CURSOR_TOKEN = /^t:[A-Za-z0-9_.~=-]{1,1024}$/
const PAGE_WINDOW = 2000

/**
 * Record lists page by number for the first 2,000 records, then continue with the `next_page_token` the last page returned.
 * The cursor is `p:<page>` or `t:<token>`, and anything else is refused before it is put in a request.
 */
const recordsPaging: PaginationStrategy = {
  pageSizeParam: "per_page",
  defaultPageSize: 50,
  maxPageSize: 200,
  itemsKey: "data",
  items: itemsOrEmpty,
  nextCursor: ({ body, url }) => {
    const info = (body as { info?: { more_records?: unknown; next_page_token?: unknown } } | null | undefined)?.info
    if (info?.more_records !== true) return null
    const token = typeof info.next_page_token === "string" && CURSOR_TOKEN.test(`t:${info.next_page_token}`) ? `t:${info.next_page_token}` : null
    if (url.searchParams.has("page_token")) return token
    const perPage = Number(url.searchParams.get("per_page")) || 50
    const page = Number(url.searchParams.get("page") ?? 1)
    if (!Number.isFinite(page) || page < 1) return null
    return page * perPage >= PAGE_WINDOW ? token : `p:${page + 1}`
  },
  applyCursor: (url, cursor) => {
    const next = new URL(url)
    if (CURSOR_PAGE.test(cursor)) {
      next.searchParams.delete("page_token")
      next.searchParams.set("page", cursor.slice(2))
    } else if (CURSOR_TOKEN.test(cursor)) {
      next.searchParams.delete("page")
      next.searchParams.set("page_token", cursor.slice(2))
    } else {
      throw new ConnectorKitError("invalid_input", "The page cursor is not one this connector produced.", { retryable: false })
    }
    return next
  },
}

const searchPaging: PaginationStrategy = {
  ...offsetPagination({ itemsKey: "data", unit: "page", positionParam: "page", pageSizeParam: "per_page", hasMorePath: ["info", "more_records"], defaultPageSize: 50, maxPageSize: 200 }),
  items: itemsOrEmpty,
}

const searchInput = z
  .object({
    module: moduleName,
    criteria: z.string().min(1).max(2000).optional().describe("Conditions like (Last_Name:equals:Smith) and (Company:starts_with:Acme). Up to 10 conditions. Operators include equals, starts_with, in, not_equal, greater_than, less_than, between."),
    email: z.string().min(3).max(320).optional().describe("Find records with this email address"),
    phone: z.string().min(3).max(40).optional().describe("Find records with this phone number"),
    word: z.string().min(1).max(200).optional().describe("Find records containing this word in any text field"),
    cursor: z.string().optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .refine((i) => [i.criteria, i.email, i.phone, i.word].filter((v) => v !== undefined).length === 1 || i.cursor !== undefined, "Give exactly one of criteria, email, phone or word")

const listInput = z
  .object({
    module: moduleName,
    fields: z.array(fieldName).min(1).max(50).describe('The field API names to return, 1 to 50, e.g. ["Last_Name", "Email", "Owner"]. Zoho requires this when listing.'),
    sortBy: z.enum(["id", "Created_Time", "Modified_Time"]).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional().describe("Needs sortBy. Zoho's default order is descending."),
    cursor: z.string().optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .refine((i) => i.sortOrder === undefined || i.sortBy !== undefined, "sortOrder needs sortBy")

const safeCode = /^[A-Z][A-Z0-9_]{0,39}$/
/**
 * A per-record failure inside a 2xx answer (Zoho reports duplicates and invalid values this way, and answers 207 for a mixed batch).
 * A write result carries its id under `details`; a real record always has a top-level `id`, so a record that happens to have custom
 * fields named status, code and message is never mistaken for a failure.
 */
const failedEntry = (body: unknown): { code: string } | undefined => {
  const data = dataOf(body)
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    const e = entry as { id?: unknown; status?: unknown; code?: unknown; message?: unknown; details?: unknown } | null
    if (e && e.id === undefined && typeof e.details === "object" && e.details !== null && e.status === "error" && typeof e.code === "string" && typeof e.message === "string") return { code: e.code }
  }
  return undefined
}

export const zohoCrm = defineConnector({
  name: "zoho-crm",
  baseUrl: "https://www.zohoapis.{region}/crm/v8",
  variables: {
    region: {
      description: "The data center your Zoho account is in: com (US), eu, in, com.au, jp, ca, sa or com.cn. It is the ending of the accounts.zoho.* address you sign in at.",
      example: "com",
      values: ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"],
    },
  },
  auth: { type: "apiKey", header: "Authorization", prefix: "Zoho-oauthtoken " },
  detectError: (body) => {
    const failed = failedEntry(body)
    if (!failed) return undefined
    const code = safeCode.test(failed.code) ? failed.code.toLowerCase() : "unknown"
    if (failed.code === "NO_PERMISSION" || failed.code === "AUTHORIZATION_FAILED") return new ConnectorKitError("forbidden", `Zoho CRM refused the change (${code}). The signed-in user may not be allowed to do this.`, { retryable: false })
    if (["DUPLICATE_DATA", "INVALID_DATA", "MANDATORY_NOT_FOUND", "MULTIPLE_OR_MULTI_ERRORS", "INVALID_MODULE"].includes(failed.code)) return new ConnectorKitError("invalid_input", `Zoho CRM rejected the record (${code}). Check the module, field names, required fields and unique values.`, { retryable: false })
    return new ConnectorKitError("upstream_error", `Zoho CRM reported an error for the record (${code}).`, { retryable: false })
  },
  detectHttpError: ({ status, body }) => {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined
    if (code === "TOO_MANY_REQUESTS" && status !== 429) return new ConnectorKitError("rate_limited", "Zoho CRM's API limit was hit (too many calls at once, or the daily credits are used up). Retry later.", { retryable: true, status })
    if (code === "OAUTH_SCOPE_MISMATCH") return new ConnectorKitError("forbidden", "The Zoho access token does not have the scope this call needs (for example ZohoCRM.modules.ALL, ZohoCRM.coql.READ or ZohoCRM.settings.modules.READ).", { retryable: false, status })
    return undefined
  },
  meta: {
    title: "Zoho CRM",
    description: "Search, read, create, update and delete records in Zoho CRM (Leads, Contacts, Accounts, Deals, custom modules), run COQL queries, and inspect modules and fields.",
    docsUrl: "https://www.zoho.com/crm/developer/docs/api/v8/",
    status: "docs-based",
    credentialEnv: "ZOHO_CRM_TOKEN",
  },
  actions: {
    "records.list": {
      description: "List records of a module with the fields you choose, up to 200 per page; pass nextCursor for the next page. Use when the user wants to browse a module. Use records.search to find specific records.",
      method: "GET",
      path: "/{module}",
      input: listInput,
      output: z.array(record),
      effect: "read",
      paginate: recordsPaging,
      buildQuery: (i) => ({
        fields: (i.fields as string[]).join(","),
        ...(i.sortBy !== undefined && { sort_by: i.sortBy }),
        ...(i.sortOrder !== undefined && { sort_order: i.sortOrder }),
      }),
    },
    "records.search": {
      description: "Find records in a module by criteria, email, phone or a word, up to 2,000 results (200 per page); pass nextCursor for more. Use for lookups like a contact by email. Very recent edits may not show yet; coql.query is exact.",
      method: "GET",
      path: "/{module}/search",
      input: searchInput,
      output: z.array(record),
      effect: "read",
      paginate: searchPaging,
      buildQuery: (i) => {
        const mode = (["criteria", "email", "phone", "word"] as const).find((k) => i[k] !== undefined)
        return mode ? { [mode]: i[mode] } : {}
      },
    },
    "record.get": {
      description: "Get one record by module and id. Pass fields to choose which fields come back.",
      method: "GET",
      path: "/{module}/{id}",
      input: z.object({ module: moduleName, id: recordId, fields: z.array(fieldName).min(1).max(50).optional() }),
      output: record,
      effect: "read",
      buildQuery: (i) => (Array.isArray(i.fields) && i.fields.length > 0 ? { fields: i.fields.join(",") } : {}),
      extract: (body) => (Array.isArray(dataOf(body)) ? (dataOf(body) as unknown[])[0] : undefined),
    },
    "coql.query": {
      description: "Run a COQL query (SQL-like, SELECT only) such as: select Last_Name, Email from Contacts where Email is not null order by Created_Time desc limit 50. Returns up to 2,000 rows; use LIMIT offset, count to page. Use for filters and sorting that records.search cannot express.",
      method: "POST",
      path: "/coql",
      input: z.object({ query: z.string().min(1).max(20000).describe("A COQL SELECT statement. Field names are API names; always give a LIMIT.") }),
      output: z.looseObject({ data: z.array(record), info: pageInfo.optional() }),
      effect: "read",
      buildBody: (i) => ({ select_query: i.query }),
      extract: (body) => body ?? { data: [] },
    },
    "record.create": {
      description: "Create one record in a module. Required fields depend on the module (fields.list shows them). The org's workflow rules run on the new record and can notify people. Returns the new record's id.",
      method: "POST",
      path: "/{module}",
      input: z.object({ module: moduleName, fields: fieldValues }),
      output: writeResult,
      effect: "write",
      buildBody: (i) => ({ data: [i.fields] }),
    },
    "record.update": {
      description: "Change fields of one record. Only the fields you pass change. The org's workflow rules run on the change and can notify people.",
      method: "PUT",
      path: "/{module}/{id}",
      input: z.object({ module: moduleName, id: recordId, fields: fieldValues }),
      output: writeResult,
      effect: "write",
      buildBody: (i) => ({ data: [i.fields] }),
    },
    "record.delete": {
      description: "Delete one record. Related subform records are deleted with it and the org's workflow rules run. Zoho's documentation does not say it can be restored, so treat it as permanent.",
      method: "DELETE",
      path: "/{module}/{id}",
      input: z.object({ module: moduleName, id: recordId }),
      output: writeResult,
      effect: "destructive",
    },
    "modules.list": {
      description: "List the modules in the account (standard and custom) with their API names and whether the signed-in user can create, edit and delete records in them. Use first when the module name is not known.",
      method: "GET",
      path: "/settings/modules",
      input: z.object({}),
      output: z.looseObject({
        modules: z.array(
          z.looseObject({
            api_name: z.string(),
            plural_label: z.string().optional(),
            singular_label: z.string().optional(),
            api_supported: z.boolean().optional(),
            creatable: z.boolean().optional(),
            editable: z.boolean().optional(),
            deletable: z.boolean().optional(),
            viewable: z.boolean().optional(),
            generated_type: z.string().optional(),
          }),
        ),
      }),
      effect: "read",
    },
    "fields.list": {
      description: "List the fields of a module with API names, types, whether they are required or read-only, and picklist options. Use before creating or updating records of an unfamiliar module.",
      method: "GET",
      path: "/settings/fields",
      input: z.object({ module: moduleName }),
      output: z.looseObject({
        fields: z.array(
          z.looseObject({
            api_name: z.string(),
            field_label: z.string().optional(),
            data_type: z.string().optional(),
            length: z.number().optional(),
            system_mandatory: z.boolean().optional(),
            read_only: z.boolean().optional(),
            pick_list_values: z.array(z.looseObject({ display_value: z.string().optional(), actual_value: z.string().optional() })).optional(),
          }),
        ),
      }),
      effect: "read",
      buildQuery: (i) => ({ module: i.module }),
    },
  },
})

export default zohoCrm
