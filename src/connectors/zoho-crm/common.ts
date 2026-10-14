import { ConnectorKitError, offsetPagination } from "../../index.js"
import type { PaginationStrategy } from "../../index.js"
import { z } from "zod"

// Shared pieces of the Zoho CRM connector: input schemas, paging, and the reading of Zoho's answers.

export const moduleName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, 'A module API name such as "Leads" or "Deals"')
  .describe('The module API name, e.g. "Leads", "Contacts", "Accounts", "Deals", or a custom module such as "Invoices". Use modules.list to see them.')
export const recordId = z.string().regex(/^\d{5,25}$/, "A numeric Zoho record id").describe("The numeric record id, e.g. 4150868000001234567")
export const fieldName = z.string().regex(/^\$?[A-Za-z][A-Za-z0-9_]{0,79}$/, 'A field API name such as "Last_Name"')
export const fieldList = z.array(fieldName).min(1).max(50)
export const relatedListName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/, 'A related list API name such as "Notes" or "Campaigns"')
  .describe("The related list's API name. relatedLists.list shows them for a module.")
export const fieldValues = z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, "Give at least one field").describe('Field values by API name, e.g. { "Last_Name": "Lovelace", "Email": "ada@acme.dev" }')
export const tagNames = z.array(z.string().min(1).max(100)).min(1).max(25).describe("Tag names")

export const record = z.looseObject({ id: z.string().optional() })
export const writeResult = z.looseObject({
  data: z.array(
    z.looseObject({
      code: z.string(),
      status: z.string(),
      message: z.string().optional(),
      details: z.looseObject({ id: z.string().optional() }).optional(),
    }),
  ),
})
export const pageInfo = z.looseObject({ count: z.number().optional(), more_records: z.boolean().optional() })

export const dataOf = (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined)
const keyOf = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined)
/** Zoho answers 204 with no body when nothing matches; that is an empty page, not a broken response. */
export const itemsOrEmpty = (body: unknown): unknown => (body === undefined ? [] : dataOf(body))
/** The first element of the array under `key` (Zoho wraps a single user, organisation or module in an array). */
export const firstOf = (key: string) => (body: unknown): unknown => {
  const list = keyOf(body, key)
  return Array.isArray(list) ? list[0] : undefined
}

const CURSOR_PAGE = /^p:[1-9]\d{0,4}$/
const CURSOR_TOKEN = /^t:[A-Za-z0-9_.~=-]{1,1024}$/
const PAGE_WINDOW = 2000

/**
 * Record lists page by number for the first 2,000 records, then continue with the `next_page_token` the last page returned.
 * The cursor is `p:<page>` or `t:<token>`, and anything else is refused before it is put in a request.
 */
export const recordsPaging: PaginationStrategy = {
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

/** Plain page-number paging for lists that have no page token (search, deleted records, notes, users). `itemsKey` is the list's key in the body. */
export const pagePaging = (itemsKey = "data"): PaginationStrategy => ({
  ...offsetPagination({ itemsKey, unit: "page", positionParam: "page", pageSizeParam: "per_page", hasMorePath: ["info", "more_records"], defaultPageSize: 50, maxPageSize: 200 }),
  items: (body) => (body === undefined ? [] : keyOf(body, itemsKey)),
})

export const pageInputs = { cursor: z.string().optional(), pageSize: z.number().int().min(1).max(200).optional() }

const safeCode = /^[A-Z][A-Z0-9_]{0,39}$/
/**
 * A per-record failure inside a 2xx answer (Zoho reports duplicates and invalid values this way, and answers 207 for a mixed batch).
 * A write result carries its id under `details`; a real record always has a top-level `id`, so a record that happens to have custom
 * fields named status, code and message is never mistaken for a failure.
 */
export const failedEntry = (body: unknown): { code: string } | undefined => {
  const data = dataOf(body)
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    const e = entry as { id?: unknown; status?: unknown; code?: unknown; message?: unknown; details?: unknown } | null
    if (e && e.id === undefined && typeof e.details === "object" && e.details !== null && e.status === "error" && typeof e.code === "string" && typeof e.message === "string") return { code: e.code }
  }
  return undefined
}

export function detectRecordError(body: unknown): ConnectorKitError | undefined {
  const failed = failedEntry(body)
  if (!failed) return undefined
  const code = safeCode.test(failed.code) ? failed.code.toLowerCase() : "unknown"
  if (failed.code === "NO_PERMISSION" || failed.code === "AUTHORIZATION_FAILED") return new ConnectorKitError("forbidden", `Zoho CRM refused the change (${code}). The signed-in user may not be allowed to do this.`, { retryable: false })
  if (["DUPLICATE_DATA", "INVALID_DATA", "MANDATORY_NOT_FOUND", "MULTIPLE_OR_MULTI_ERRORS", "INVALID_MODULE", "ID_ALREADY_CONVERTED", "RECORD_LOCKED"].includes(failed.code)) {
    return new ConnectorKitError("invalid_input", `Zoho CRM rejected the request (${code}). Check the module, field names, required fields, unique values and the record's state.`, { retryable: false })
  }
  return new ConnectorKitError("upstream_error", `Zoho CRM reported an error for the record (${code}).`, { retryable: false })
}
