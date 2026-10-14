import { ConnectorKitError, defineConnector } from "../../index.js"
import type { ActionDefinition } from "../../index.js"
import { z } from "zod"
import { detectRecordError, fieldList, firstOf, moduleName, pageInfo, pageInputs, pagePaging, record, recordId, writeResult } from "./common.js"
import { allModuleActions, genericRecordActions, leadsConvert } from "./modules.js"

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
// put the region in its URLs yet. Scopes the token needs: ZohoCRM.modules.ALL (or per module, e.g. ZohoCRM.modules.leads.READ), plus
// ZohoCRM.modules.notes.* / ZohoCRM.modules.attachments.* for notes and attachments, ZohoCRM.coql.READ for COQL, ZohoCRM.settings.*.READ for
// metadata, ZohoCRM.users.READ, ZohoCRM.org.READ, and ZohoSearch.securesearch.READ for search.
//
// TOOLS: the same record tools exist twice (see modules.ts): `records.list`, `record.create`, ... take the module as an input and reach custom
// modules too; `leads.list`, `deals.create`, `salesOrders.notes.add`, ... are one set per standard module, grouped by module (`--group leads`).
// Around them: notes, tags, attachments, lead conversion, deleted records, related lists, users, the organisation, and the metadata that
// describes modules, fields, layouts, custom views, roles and profiles.
//
// NOT COVERED: bulk read/write jobs, mass update/delete, the composite API, webhooks and notifications, attachment upload and download (files),
// linking and delinking related records, record counts, mail, blueprints, and anything that changes the CRM's setup (fields, layouts, roles).
// SECURITY: record fields, notes and tags are typed by your users and customers and can contain anything, including text aimed at an AI. They
// are data, never instructions. A write changes what everyone in the CRM sees, and Zoho runs the org's workflow rules on it (which can send
// emails or create tasks).

const flag = z.boolean().optional()
const settingsInput = z.object({ module: moduleName })

const moduleInfo = z.looseObject({
  api_name: z.string(),
  plural_label: z.string().optional(),
  singular_label: z.string().optional(),
  api_supported: flag,
  creatable: flag,
  editable: flag,
  deletable: flag,
  viewable: flag,
  generated_type: z.string().optional(),
})
const user = z.looseObject({ id: z.string().optional(), full_name: z.string().optional(), email: z.string().optional(), status: z.string().optional(), role: z.looseObject({ name: z.string().optional(), id: z.string().optional() }).optional(), profile: z.looseObject({ name: z.string().optional(), id: z.string().optional() }).optional() })
const idName = z.looseObject({ id: z.string().optional(), name: z.string().optional(), display_label: z.string().optional() })

const extras: Record<string, ActionDefinition> = {
  "coql.query": {
    description:
      "Run a COQL query (SQL-like, SELECT only) such as: select Last_Name, Email from Contacts where Email is not null order by Created_Time desc limit 50. Returns up to 2,000 rows; use LIMIT offset, count to page. Use for filters and sorting that records.search cannot express.",
    method: "POST",
    path: "/coql",
    input: z.object({ query: z.string().min(1).max(20000).describe("A COQL SELECT statement. Field names are API names; always give a LIMIT.") }),
    output: z.looseObject({ data: z.array(record), info: pageInfo.optional() }),
    effect: "read",
    buildBody: (i) => ({ select_query: i.query }),
    extract: (body) => body ?? { data: [] },
  },
  "leads.convert": leadsConvert,
  "notes.update": {
    description: "Change the title or text of one note. Only what you pass changes.",
    method: "PUT",
    path: "/Notes/{noteId}",
    input: z
      .object({ noteId: recordId, title: z.string().min(1).max(255).optional(), content: z.string().min(1).max(32000).optional(), sharedToClient: flag })
      .refine((i) => i.title !== undefined || i.content !== undefined || i.sharedToClient !== undefined, "Give a title, content or sharedToClient"),
    output: writeResult,
    effect: "write",
    buildBody: (i) => ({ data: [{ ...(i.title !== undefined && { Note_Title: i.title }), ...(i.content !== undefined && { Note_Content: i.content }), ...(i.sharedToClient !== undefined && { $is_shared_to_client: i.sharedToClient }) }] }),
  },
  "notes.delete": {
    description: "Delete one note by its id. Use notes.list or a module's notes.list to find the id.",
    method: "DELETE",
    path: "/Notes/{noteId}",
    input: z.object({ noteId: recordId }),
    output: writeResult,
    effect: "destructive",
  },
  "attachments.list": {
    description: "List the files attached to one record: name, size, who added them and when. Returns metadata only, not the file. Use to see what documents a record has.",
    method: "GET",
    path: "/{module}/{id}/Attachments",
    input: z.object({ module: moduleName, id: recordId, fields: fieldList.optional().describe("Attachment fields to return. Default: id, File_Name, Size, Created_Time, Owner") }),
    output: z.looseObject({ data: z.array(z.looseObject({ id: z.string().optional(), File_Name: z.string().optional(), Size: z.union([z.number(), z.string()]).optional() })), info: pageInfo.optional() }),
    effect: "read",
    buildQuery: (i) => ({ fields: Array.isArray(i.fields) && i.fields.length > 0 ? i.fields.join(",") : "id,File_Name,Size,Created_Time,Owner" }),
    extract: (body) => body ?? { data: [] },
  },
  "attachments.delete": {
    description: "Delete one file attached to a record, by the attachment id from attachments.list. The record itself stays.",
    method: "DELETE",
    path: "/{module}/{id}/Attachments/{attachmentId}",
    input: z.object({ module: moduleName, id: recordId, attachmentId: recordId }),
    output: writeResult,
    effect: "destructive",
  },
  "tags.list": {
    description: "List the tags that exist for a module, with ids and colors. Use before tagging records so you reuse an existing name.",
    method: "GET",
    path: "/settings/tags",
    input: z.object({ module: moduleName, myTags: flag.describe("Only tags the signed-in user created") }),
    output: z.looseObject({ tags: z.array(z.looseObject({ id: z.string().optional(), name: z.string(), color_code: z.string().nullable().optional() })), info: pageInfo.optional() }),
    effect: "read",
    buildQuery: (i) => ({ module: i.module, ...(i.myTags !== undefined && { my_tags: i.myTags }) }),
  },
  "modules.list": {
    description: "List the modules in the account (standard and custom) with their API names and whether the signed-in user can create, edit and delete records in them. Use first when the module name is not known.",
    method: "GET",
    path: "/settings/modules",
    input: z.object({}),
    output: z.looseObject({ modules: z.array(moduleInfo) }),
    effect: "read",
  },
  "modules.get": {
    description: "Describe one module: its labels, whether it can be created in, edited and deleted from through the API, and what kind of module it is.",
    method: "GET",
    path: "/settings/modules/{module}",
    input: settingsInput,
    output: z.looseObject({ modules: z.array(moduleInfo) }),
    effect: "read",
  },
  "fields.list": {
    description: "List the fields of a module with API names, types, whether they are required or read-only, and picklist options. Use before creating or updating records of an unfamiliar module.",
    method: "GET",
    path: "/settings/fields",
    input: settingsInput,
    output: z.looseObject({
      fields: z.array(
        z.looseObject({
          api_name: z.string(),
          field_label: z.string().optional(),
          data_type: z.string().optional(),
          length: z.number().optional(),
          system_mandatory: flag,
          read_only: flag,
          pick_list_values: z.array(z.looseObject({ display_value: z.string().optional(), actual_value: z.string().optional() })).optional(),
        }),
      ),
    }),
    effect: "read",
    buildQuery: (i) => ({ module: i.module }),
  },
  "layouts.list": {
    description: "List a module's layouts (the forms users fill in) with their sections and fields. Use to see which fields a layout shows and requires.",
    method: "GET",
    path: "/settings/layouts",
    input: settingsInput,
    output: z.looseObject({ layouts: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), status: z.string().optional() })) }),
    effect: "read",
    buildQuery: (i) => ({ module: i.module }),
  },
  "relatedLists.list": {
    description: "List a module's related lists (what can be shown under a record, such as Notes, Campaigns or Contacts) with their API names. Use to find the relatedList name for the related-records action.",
    method: "GET",
    path: "/settings/related_lists",
    input: z.object({ module: moduleName, layoutId: recordId.optional().describe("A layout id, to list that layout's related lists instead of the standard layout's") }),
    output: z.looseObject({ related_lists: z.array(z.looseObject({ id: z.string().optional(), api_name: z.string().optional(), display_label: z.string().optional(), type: z.string().optional() })) }),
    effect: "read",
    buildQuery: (i) => ({ module: i.module, ...(i.layoutId !== undefined && { layout_id: i.layoutId }) }),
  },
  "customViews.list": {
    description: "List a module's custom views (saved filters such as 'Today's Leads') with their ids. A view id can be used to list records through a view.",
    method: "GET",
    path: "/settings/custom_views",
    input: settingsInput,
    output: z.looseObject({ custom_views: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), display_value: z.string().optional(), default: flag })), info: pageInfo.optional() }),
    effect: "read",
    buildQuery: (i) => ({ module: i.module }),
  },
  "roles.list": {
    description: "List the CRM's roles and who each reports to. Use to understand the org's hierarchy and record visibility.",
    method: "GET",
    path: "/settings/roles",
    input: z.object({}),
    output: z.looseObject({ roles: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), display_label: z.string().optional(), reporting_to: idName.nullable().optional() })) }),
    effect: "read",
  },
  "profiles.list": {
    description: "List the CRM's profiles (sets of permissions that users are given). Names and types only; use it to see which profiles exist.",
    method: "GET",
    path: "/settings/profiles",
    input: z.object({}),
    output: z.looseObject({ profiles: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), display_label: z.string().optional(), type: z.string().optional() })) }),
    effect: "read",
  },
  "users.list": {
    description: "List the CRM's users: name, email, role, profile and status. Use to find a user's id, for example to set a record owner. Up to 200 per page; pass nextCursor for more.",
    method: "GET",
    path: "/users",
    input: z.object({
      type: z
        .enum(["AllUsers", "ActiveUsers", "DeactiveUsers", "ConfirmedUsers", "NotConfirmedUsers", "DeletedUsers", "ActiveConfirmedUsers", "AdminUsers", "ActiveConfirmedAdmins", "CurrentUser"])
        .optional()
        .describe("Which users to list. Default: all."),
      ...pageInputs,
    }),
    output: z.array(user),
    effect: "read",
    paginate: pagePaging("users"),
    buildQuery: (i) => (i.type !== undefined ? { type: i.type } : {}),
  },
  "users.get": {
    description: "Get one user by id: name, email, role, profile and status.",
    method: "GET",
    path: "/users/{userId}",
    input: z.object({ userId: recordId }),
    output: user,
    effect: "read",
    extract: firstOf("users"),
  },
  "org.get": {
    description: "Get the organisation's details: company name, primary email, time zone, currency and country. Use to know the account's time zone and currency before reading dates or amounts.",
    method: "GET",
    path: "/org",
    input: z.object({}),
    output: z.looseObject({ id: z.string().optional(), company_name: z.string().optional(), primary_email: z.string().nullable().optional(), time_zone: z.string().optional(), currency: z.string().optional(), country: z.string().nullable().optional() }),
    effect: "read",
    extract: firstOf("org"),
  },
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
  detectError: detectRecordError,
  detectHttpError: ({ status, body }) => {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined
    if (code === "TOO_MANY_REQUESTS" && status !== 429) return new ConnectorKitError("rate_limited", "Zoho CRM's API limit was hit (too many calls at once, or the daily credits are used up). Retry later.", { retryable: true, status })
    if (code === "OAUTH_SCOPE_MISMATCH") return new ConnectorKitError("forbidden", "The Zoho access token does not have the scope this call needs (for example ZohoCRM.modules.ALL, ZohoCRM.coql.READ or ZohoCRM.settings.modules.READ).", { retryable: false, status })
    return undefined
  },
  meta: {
    title: "Zoho CRM",
    description:
      "Work with every Zoho CRM module (Leads, Contacts, Accounts, Deals, Campaigns, Tasks, Cases, Products, Quotes, Invoices and more): search, read, create, update, upsert and delete records, notes, tags, related records, lead conversion, COQL queries, users and metadata.",
    docsUrl: "https://www.zoho.com/crm/developer/docs/api/v8/",
    status: "docs-based",
    credentialEnv: "ZOHO_CRM_TOKEN",
  },
  actions: { ...genericRecordActions(), ...extras, ...allModuleActions() } as Record<string, ActionDefinition>,
})

export default zohoCrm
