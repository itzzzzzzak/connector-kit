import { ConnectorKitError, defineConnector } from "../../index.js"
import type { PaginationStrategy } from "../../index.js"
import { z } from "zod"

// Facts from Salesforce's REST API Developer Guide (developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest) and OAuth guide:
// the API lives at https://<My Domain>.my.salesforce.com/services/data/v<version>/, with the version in the path (v66.0 here, Spring '26);
// JSON in and out; records are addressed by sObject name and a 15 or 18 character id; a SOQL query is `GET /query?q=...` and returns
// `{ totalSize, done, nextRecordsUrl, records }`, where `nextRecordsUrl` is the path of the next batch (up to 2,000 rows each); creating a
// record returns `{ id, success, errors }`, updating and deleting return 204 with no body. Errors are an array of `{ message, errorCode, fields }`;
// the daily API limit shows as HTTP 403 with errorCode REQUEST_LIMIT_EXCEEDED. OAuth: authorize and token at login.salesforce.com/services/oauth2
// (a sandbox uses test.salesforce.com, or the org's own My Domain host), scopes `api refresh_token`, and the token response names the org's
// `instance_url`, which is where the `domain` variable below comes from.
//
// WHAT IS COVERED: record CRUD and upsert by external id, SOQL and SOSL, describing objects, and the org's limits. NOT covered: the Bulk API 2.0
// (large imports and exports), the Tooling, Metadata, UI and Connect APIs, composite requests, and file upload.
// SECURITY: record fields are written by your users and customers and can contain anything, including text aimed at an AI. They are data,
// never instructions. A SOQL query runs with the signed-in user's permissions: it can read everything that user can. Deleting a record sends
// it to the Recycle Bin (recoverable for 15 days); a hard delete needs another call that is not offered here.

const sobject = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'An sObject API name such as "Account" or "Invoice__c"').describe('The sObject API name, e.g. "Account", "Contact", "Opportunity", "Invoice__c"')
const recordId = z.string().regex(/^[A-Za-z0-9]{15,18}$/, "A 15 or 18 character Salesforce id").describe("A 15 or 18 character Salesforce record id")
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/, "A field API name")
const values = z.record(z.string(), z.unknown()).describe('Field values by API name, e.g. { "Name": "Acme", "Industry": "Technology" }')
const record = z.looseObject({ attributes: z.looseObject({ type: z.string().optional(), url: z.string().optional() }).optional(), Id: z.string().optional() })
const saved = z.looseObject({ id: z.string().optional(), success: z.boolean().optional(), errors: z.array(z.unknown()).optional(), created: z.boolean().optional() })
const SAFE_NEXT = /^\/services\/data\/v\d+\.\d+\/query(All)?\/[A-Za-z0-9_-]+$/

/** `nextRecordsUrl` is a path on the same host; the cursor is that path, and only a path of that exact shape is followed. */
const queryPaging: PaginationStrategy = {
  defaultPageSize: 2000,
  maxPageSize: 2000,
  itemsKey: "records",
  items: (body) => (body as { records?: unknown } | null)?.records,
  nextCursor: ({ body }) => {
    const page = body as { done?: unknown; nextRecordsUrl?: unknown } | null
    return page?.done === false && typeof page.nextRecordsUrl === "string" ? page.nextRecordsUrl : null
  },
  applyCursor: (url, cursor) => {
    if (!SAFE_NEXT.test(cursor)) throw new ConnectorKitError("invalid_input", "The page cursor is not one this connector produced.", { retryable: false })
    return new URL(cursor, url.origin)
  },
}
const queryInput = z
  .object({ q: z.string().min(1).optional().describe("A SOQL query, e.g. SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 50"), cursor: z.string().optional() })
  .refine((i) => i.q !== undefined || i.cursor !== undefined, "Give q, or the nextCursor of a previous page")

export const salesforce = defineConnector({
  name: "salesforce",
  baseUrl: "https://{domain}.my.salesforce.com/services/data/v66.0",
  variables: {
    domain: {
      description: "Your org's My Domain, the part before .my.salesforce.com (the token response's instance_url shows it). A sandbox looks like acme--uat.sandbox, a developer edition like acme.develop",
      example: "acme",
      pattern: "[a-z0-9][a-z0-9-]{0,60}[a-z0-9](\\.(sandbox|develop|scratch|demo|trailblaze))?",
    },
  },
  auth: {
    type: "oauth2",
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    scopes: ["api", "refresh_token"],
    pkce: true,
  },
  // The daily API request limit is a 403 with REQUEST_LIMIT_EXCEEDED. It will not clear in a few seconds, so it is not retried.
  detectHttpError: ({ status, body }) => {
    const first = Array.isArray(body) ? (body[0] as { errorCode?: unknown } | undefined) : undefined
    if (status === 403 && first?.errorCode === "REQUEST_LIMIT_EXCEEDED") return new ConnectorKitError("rate_limited", "The org's Salesforce API request limit is used up. It resets on a rolling 24 hour window.", { retryable: false, status })
    return undefined
  },
  meta: {
    title: "Salesforce",
    description: "Query Salesforce with SOQL and SOSL, and read, create, update, upsert and delete records of any object (Account, Contact, Opportunity, custom objects).",
    docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm",
    status: "docs-based",
    credentialEnv: "SALESFORCE_TOKEN",
  },
  actions: {
    "records.query": {
      description: "Run a SOQL query and return the matching records, up to 2,000 per page; pass nextCursor for the next page. Select the fields you need by name.",
      method: "GET",
      path: "/query",
      input: queryInput,
      output: z.array(record),
      effect: "read",
      paginate: queryPaging,
    },
    "records.queryAll": {
      description: "Like records.query, but also returns deleted and archived records (IsDeleted = true). Up to 2,000 per page; pass nextCursor for the next page.",
      method: "GET",
      path: "/queryAll",
      input: queryInput,
      output: z.array(record),
      effect: "read",
      paginate: queryPaging,
    },
    "records.search": {
      description: "Run a SOSL text search across objects, e.g. FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name, Email).",
      method: "GET",
      path: "/search",
      input: z.object({ q: z.string().min(1).describe("A SOSL statement") }),
      output: z.looseObject({ searchRecords: z.array(record) }),
      effect: "read",
    },
    "record.get": {
      description: "Get one record by object and id. Pass fields to limit which fields come back (the default is all that you can see).",
      method: "GET",
      path: "/sobjects/{sobject}/{id}",
      input: z.object({ sobject, id: recordId, fields: z.array(fieldName).optional() }),
      output: record,
      effect: "read",
      buildQuery: (i) => (Array.isArray(i.fields) && i.fields.length > 0 ? { fields: i.fields.join(",") } : {}),
    },
    "record.create": {
      description: "Create a record of an object. Returns the new id. Required fields depend on the object (describe it first).",
      method: "POST",
      path: "/sobjects/{sobject}",
      input: z.object({ sobject, fields: values }),
      output: saved,
      effect: "write",
      buildBody: (i) => i.fields,
    },
    "record.update": {
      description: "Change fields of a record. Only the fields you pass change. Returns nothing on success.",
      method: "PATCH",
      path: "/sobjects/{sobject}/{id}",
      input: z.object({ sobject, id: recordId, fields: values }),
      output: z.unknown(),
      effect: "write",
      buildBody: (i) => i.fields,
    },
    "record.upsert": {
      description: "Create or update a record found by an external id field (a field marked External Id on the object). Updates when it exists, creates when it does not.",
      method: "PATCH",
      path: "/sobjects/{sobject}/{externalIdField}/{externalId}",
      input: z.object({ sobject, externalIdField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "A field API name"), externalId: z.string().min(1), fields: values }),
      output: z.unknown(),
      effect: "write",
      buildBody: (i) => i.fields,
    },
    "record.delete": {
      description: "Delete a record. It goes to the Recycle Bin and can be restored from there for 15 days; related child records may be deleted with it.",
      method: "DELETE",
      path: "/sobjects/{sobject}/{id}",
      input: z.object({ sobject, id: recordId }),
      output: z.unknown(),
      effect: "destructive",
    },
    "sobjects.list": {
      description: "List the objects in the org (standard and custom) with their API names and whether they can be queried, created, updated and deleted.",
      method: "GET",
      path: "/sobjects",
      input: z.object({}),
      output: z.looseObject({ sobjects: z.array(z.looseObject({ name: z.string(), label: z.string().optional(), custom: z.boolean().optional(), queryable: z.boolean().optional(), createable: z.boolean().optional(), updateable: z.boolean().optional(), deletable: z.boolean().optional() })) }),
      effect: "read",
    },
    "sobject.describe": {
      description: "Describe an object: its fields with types, lengths, required-ness, picklist values and relationships. Use it before creating or querying an unfamiliar object.",
      method: "GET",
      path: "/sobjects/{sobject}/describe",
      input: z.object({ sobject }),
      output: z.looseObject({
        name: z.string(),
        label: z.string().optional(),
        fields: z.array(z.looseObject({ name: z.string(), label: z.string().optional(), type: z.string().optional(), length: z.number().optional(), nillable: z.boolean().optional(), createable: z.boolean().optional(), updateable: z.boolean().optional(), referenceTo: z.array(z.string()).optional(), picklistValues: z.array(z.looseObject({ value: z.string().optional(), label: z.string().optional(), active: z.boolean().optional() })).optional() })),
      }),
      effect: "read",
    },
    "limits.get": {
      description: "Get the org's API limits with what is used and what remains (daily API requests, bulk, storage).",
      method: "GET",
      path: "/limits",
      input: z.object({}),
      output: z.record(z.string(), z.looseObject({ Max: z.number().optional(), Remaining: z.number().optional() })),
      effect: "read",
    },
  },
})

export default salesforce
