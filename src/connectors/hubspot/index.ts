import { bodyCursorPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from HubSpot's official public API spec collection (CRM Contacts / Companies / Deals, v3):
// base URL, paths, `paging.next.after` pagination, `{ properties }` bodies, OAuth endpoints.

// Every CRM object has the same shape; its fields live in `properties`, whose values are strings (or null).
const object = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.string().nullable()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archived: z.boolean().optional(),
})
const properties = z.array(z.string()).optional().describe("Property names to return, e.g. [\"email\", \"firstname\"]. HubSpot returns a few default properties if omitted.")
const values = z.record(z.string(), z.string()).describe("Property values by internal name, e.g. { \"email\": \"a@b.com\", \"firstname\": \"Ada\" }")
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = () => bodyCursorPagination({ itemsKey: "results", cursorPath: ["paging", "next", "after"], cursorParam: "after", pageSizeParam: "limit", defaultPageSize: 30, maxPageSize: 100 })

export const hubspot = defineConnector({
  name: "hubspot",
  baseUrl: "https://api.hubapi.com",
  // A private-app access token works as a Bearer token; OAuth is for apps acting for many HubSpot accounts.
  auth: {
    type: "oauth2",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read"],
  },
  meta: {
    title: "HubSpot",
    description: "Read CRM contacts, companies and deals, and create or update them.",
    docsUrl: "https://developers.hubspot.com/docs/api/crm/contacts",
    status: "docs-based",
    credentialEnv: "HUBSPOT_TOKEN",
  },
  actions: {
    "contacts.list": {
      description: "List CRM contacts (people). Use when the user asks who is in the CRM. Returns one bounded page; pass nextCursor for more. To find a specific person by email use contacts.get with idProperty \"email\".",
      method: "GET",
      path: "/crm/v3/objects/contacts",
      input: z.object({ properties, archived: z.boolean().optional(), ...paging }),
      output: z.array(object),
      effect: "read",
      paginate: pagination(),
    },
    "contacts.get": {
      description: "Get one contact by id, or by email: set idProperty to \"email\" and contactId to the address.",
      method: "GET",
      path: "/crm/v3/objects/contacts/{contactId}",
      input: z.object({ contactId: z.string(), idProperty: z.string().optional().describe('Look up by this property instead of the id, e.g. "email"'), properties }),
      output: object,
      effect: "read",
    },
    "contacts.create": {
      description: "Create a contact. This ADDS A RECORD to the user's CRM: only use when they clearly asked. Give at least an email or a name in properties.",
      method: "POST",
      path: "/crm/v3/objects/contacts",
      input: z.object({ properties: values }),
      output: object,
      effect: "write",
    },
    "contacts.update": {
      description: "Update properties of an existing contact. This CHANGES the user's CRM: only use when they clearly asked.",
      method: "PATCH",
      path: "/crm/v3/objects/contacts/{contactId}",
      input: z.object({ contactId: z.string(), properties: values }),
      output: object,
      effect: "write",
      safeToRetry: true, // sets the given properties to the given values: repeating it changes nothing further
    },
    "companies.list": {
      description: "List CRM companies (organizations). Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/crm/v3/objects/companies",
      input: z.object({ properties, archived: z.boolean().optional(), ...paging }),
      output: z.array(object),
      effect: "read",
      paginate: pagination(),
    },
    "companies.get": {
      description: "Get one company by id, optionally choosing which properties to return.",
      method: "GET",
      path: "/crm/v3/objects/companies/{companyId}",
      input: z.object({ companyId: z.string(), properties }),
      output: object,
      effect: "read",
    },
    "companies.create": {
      description: "Create a company. This ADDS A RECORD to the user's CRM: only use when they clearly asked. Usually give name and domain in properties.",
      method: "POST",
      path: "/crm/v3/objects/companies",
      input: z.object({ properties: values }),
      output: object,
      effect: "write",
    },
    "deals.list": {
      description: "List CRM deals (sales opportunities). Use when the user asks about the pipeline. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/crm/v3/objects/deals",
      input: z.object({ properties, archived: z.boolean().optional(), ...paging }),
      output: z.array(object),
      effect: "read",
      paginate: pagination(),
    },
    "deals.get": {
      description: "Get one deal by id, optionally choosing which properties to return (for example dealname, amount, dealstage).",
      method: "GET",
      path: "/crm/v3/objects/deals/{dealId}",
      input: z.object({ dealId: z.string(), properties }),
      output: object,
      effect: "read",
    },
    "deals.create": {
      description: "Create a deal. This ADDS A RECORD to the user's CRM: only use when they clearly asked. Usually give dealname, pipeline, dealstage and amount in properties.",
      method: "POST",
      path: "/crm/v3/objects/deals",
      input: z.object({ properties: values }),
      output: object,
      effect: "write",
    },
  },
})

export default hubspot
