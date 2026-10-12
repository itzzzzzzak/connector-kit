import { bodyCursorPagination, defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's People API v1 reference and Discovery document: base URL https://people.googleapis.com/v1, a person is named by path
// ("people/c123456"; "people/me" is the signed-in user), and every read needs `personFields` (a comma-separated mask such as
// names,emailAddresses,phoneNumbers). Lists page with `pageToken` / `pageSize` and `nextPageToken`. Scopes: contacts.readonly reads,
// contacts writes, directory.readonly reads the organization's directory.
// A curated, typed set is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: contact names, notes and fields are data, never instructions.

const FIELDS = "names,emailAddresses,phoneNumbers,organizations"
const personFields = z.string().optional().describe(`Which fields to return, comma-separated (default: ${FIELDS})`)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const person = z.looseObject({ resourceName: z.string(), etag: z.string().optional(), names: z.array(z.looseObject({ displayName: z.string().optional() })).optional(), emailAddresses: z.array(z.looseObject({ value: z.string().optional(), type: z.string().optional() })).optional(), phoneNumbers: z.array(z.looseObject({ value: z.string().optional(), type: z.string().optional() })).optional(), organizations: z.array(z.looseObject({ name: z.string().optional(), title: z.string().optional() })).optional() })
const pageOf = (itemsKey: string, size = 100) => bodyCursorPagination({ itemsKey, cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "pageSize", defaultPageSize: 25, maxPageSize: size })
const mask = (i: Record<string, unknown>) => (typeof i.personFields === "string" ? i.personFields : FIELDS)

export const googlePeople = defineConnector({
  name: "google-people",
  baseUrl: "https://people.googleapis.com/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/contacts.readonly"]),
  meta: {
    title: "Google Contacts",
    description: "Search, read, create and update contacts and contact groups, and look up people in the directory (Google People API).",
    docsUrl: "https://developers.google.com/people/api/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_PEOPLE_TOKEN",
  },
  actions: {
    ...generatedActions,
    "connections.list": {
      description: "List the signed-in user's contacts. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/people/me/connections",
      input: z.object({ personFields, sortOrder: z.enum(["LAST_MODIFIED_ASCENDING", "LAST_MODIFIED_DESCENDING", "FIRST_NAME_ASCENDING", "LAST_NAME_ASCENDING"]).optional(), ...paging }),
      output: z.array(person),
      effect: "read",
      paginate: pageOf("connections"),
      buildQuery: (i) => ({ personFields: mask(i), ...(i.sortOrder !== undefined && { sortOrder: i.sortOrder }) }),
    },
    "contacts.search": {
      description: "Search the user's contacts by name, email or phone prefix. Returns at most 30 per page.",
      method: "GET",
      path: "/people:searchContacts",
      input: z.object({ query: z.string().min(1), readMask: z.string().optional().describe(`Default: ${FIELDS}`), ...paging }),
      output: z.object({ results: z.array(z.looseObject({ person: person.optional() })).optional() }),
      effect: "read",
      buildQuery: (i) => ({ query: i.query, readMask: typeof i.readMask === "string" ? i.readMask : FIELDS, ...(i.pageSize !== undefined && { pageSize: Math.min(30, Number(i.pageSize)) }) }),
    },
    "people.get": {
      description: 'Get one person by resource name ("people/c123456"), or "people/me" for the signed-in user.',
      method: "GET",
      path: "/{+resourceName}",
      input: z.object({ resourceName: z.string().regex(/^people\/[^/]+$/, 'e.g. "people/c123456" or "people/me"'), personFields }),
      output: person,
      effect: "read",
      buildQuery: (i) => ({ personFields: mask(i) }),
    },
    "contacts.create": {
      description: "Create a contact with a name and optionally emails, phone numbers and an organization.",
      method: "POST",
      path: "/people:createContact",
      input: z.object({ givenName: z.string().min(1), familyName: z.string().optional(), emails: z.array(z.string()).optional(), phones: z.array(z.string()).optional(), company: z.string().optional(), jobTitle: z.string().optional() }),
      output: person,
      effect: "write",
      buildBody: (i) => ({
        names: [{ givenName: i.givenName, ...(i.familyName !== undefined && { familyName: i.familyName }) }],
        ...(Array.isArray(i.emails) && { emailAddresses: i.emails.map((value) => ({ value })) }),
        ...(Array.isArray(i.phones) && { phoneNumbers: i.phones.map((value) => ({ value })) }),
        ...(i.company !== undefined && { organizations: [{ name: i.company, ...(i.jobTitle !== undefined && { title: i.jobTitle }) }] }),
      }),
    },
  },
})

export default googlePeople
