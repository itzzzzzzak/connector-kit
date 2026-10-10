import { bodyCursorPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Airtable's official Web API reference pages (list/create/update/delete record, OAuth reference):
// base URL, `offset` pagination in the body, single-record write form, PATCH (partial) vs PUT (destructive),
// and OAuth: PKCE S256, Basic client auth, space-separated scopes, rotating refresh tokens.

const record = z.object({ id: z.string(), createdTime: z.string().optional(), fields: z.record(z.string(), z.unknown()) })
const base = z.object({ id: z.string(), name: z.string().optional(), permissionLevel: z.string().optional() })
const table = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  primaryFieldId: z.string().optional(),
  fields: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), description: z.string().optional() })),
})

const where = {
  baseId: z.string().describe("Base id, starts with \"app\" (find it with bases.list)"),
  tableIdOrName: z.string().describe("Table id (starts with \"tbl\") or the table's name"),
}
const cellValues = z.record(z.string(), z.unknown()).describe('Field values by field name, e.g. { "Name": "Ship it", "Status": "Todo" }')
const typecast = z.boolean().optional().describe("Let Airtable convert values (for example create missing select options). Off by default.")

export const airtable = defineConnector({
  name: "airtable",
  baseUrl: "https://api.airtable.com/v0",
  // A personal access token works as a Bearer token. OAuth (for apps acting for many users) requires PKCE and
  // authenticates the client with HTTP Basic; access tokens last 60 minutes and the refresh token rotates.
  auth: {
    type: "oauth2",
    authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    scopes: ["data.records:read", "schema.bases:read"],
    clientAuth: "basic",
  },
  meta: {
    title: "Airtable",
    description: "List bases and tables, and read, create, update and delete records.",
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    status: "docs-based",
    credentialEnv: "AIRTABLE_TOKEN",
  },
  actions: {
    "bases.list": {
      description: "List the Airtable bases the token can access. Use first, to find a base id. Needs the schema.bases:read scope.",
      method: "GET",
      path: "/meta/bases",
      input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(base),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "bases", cursorPath: ["offset"], cursorParam: "offset", pageSizeParam: null }),
    },
    "tables.list": {
      description: "List the tables in a base with their fields and field types. Use before reading or writing records, to learn the exact field names.",
      method: "GET",
      path: "/meta/bases/{baseId}/tables",
      input: z.object({ baseId: where.baseId }),
      output: z.object({ tables: z.array(table) }),
      effect: "read",
    },
    "records.list": {
      description: "List records in a table. Use to read or search rows; filterByFormula takes an Airtable formula such as {Status}='Todo'. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/{baseId}/{tableIdOrName}",
      input: z.object({
        ...where,
        fields: z.array(z.string()).optional().describe("Only return these field names"),
        filterByFormula: z.string().optional().describe("Airtable formula; records where it is true are returned"),
        view: z.string().optional().describe("View name or id; returns only that view's records, in its order"),
        maxRecords: z.number().int().positive().optional().describe("Stop after this many records in total"),
        sort_field: z.string().optional().describe("Field name to sort by"),
        sort_direction: z.enum(["asc", "desc"]).optional(),
        cursor: z.string().optional(),
        pageSize: z.number().optional(),
      }),
      output: z.array(record),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "records", cursorPath: ["offset"], cursorParam: "offset", pageSizeParam: "pageSize", defaultPageSize: 30, maxPageSize: 100 }),
      // Airtable's conventions: fields[]=a&fields[]=b and sort[0][field]=Name
      buildQuery: ({ fields, sort_field, sort_direction, ...rest }) => ({
        ...rest,
        ...(fields !== undefined && { "fields[]": fields }),
        ...(sort_field !== undefined && { "sort[0][field]": sort_field, "sort[0][direction]": sort_direction ?? "asc" }),
      }),
    },
    "records.get": {
      description: "Get one record by id (starts with \"rec\").",
      method: "GET",
      path: "/{baseId}/{tableIdOrName}/{recordId}",
      input: z.object({ ...where, recordId: z.string() }),
      output: record,
      effect: "read",
    },
    "records.create": {
      description: "Create one record in a table. This ADDS A ROW to the user's base: only use when they clearly asked. Field names must match the table (see tables.list).",
      method: "POST",
      path: "/{baseId}/{tableIdOrName}",
      input: z.object({ ...where, fields: cellValues, typecast }),
      output: record,
      effect: "write",
    },
    "records.update": {
      description: "Update some fields of one record; fields you do not mention are left as they are. This CHANGES the user's base: only use when they clearly asked.",
      method: "PATCH",
      path: "/{baseId}/{tableIdOrName}/{recordId}",
      input: z.object({ ...where, recordId: z.string(), fields: cellValues, typecast }),
      output: record,
      effect: "write",
      safeToRetry: true, // PATCH sets the given fields to the given values: repeating it changes nothing further
    },
    "records.delete": {
      description: "Permanently DELETE one record from a table. Cannot be undone from here: only use when the user explicitly asked to delete it.",
      method: "DELETE",
      path: "/{baseId}/{tableIdOrName}/{recordId}",
      input: z.object({ ...where, recordId: z.string() }),
      output: z.object({ id: z.string(), deleted: z.boolean() }),
      effect: "destructive",
    },
  },
})

export default airtable
