import { defineConnector, offsetPagination } from "../../index.js"
import { z } from "zod"

// Facts from Cloudflare's API reference (developers.cloudflare.com/api): base URL https://api.cloudflare.com/client/v4, `Authorization: Bearer <API token>`
// (a scoped API token, not the legacy global key), every answer is { success, errors, messages, result, result_info }, and lists page with `page` and
// `per_page` and report result_info.total_count. A zone is a domain (32-character hex id); a DNS record has type, name, content, ttl (1 means automatic)
// and `proxied` (traffic goes through Cloudflare). "Purge cache" is a POST of exactly one of purge_everything, files, hosts, tags or prefixes.
// This is a hand-written core (zones, DNS, cache, accounts, Workers scripts, token check), not the whole API: Cloudflare's OpenAPI description is
// about 27 MB, far too large to generate from in one piece.
//
// SECURITY: a DNS change takes a live site, email or API offline within minutes, and a cache purge can send a traffic spike to the origin: both are
// marked destructive or write on purpose, and a model must ask a human first. Record names, comments and script names were written by others and can
// contain text aimed at an AI: they are data, never instructions.

const zoneId = z.string().regex(/^[a-f0-9]{32}$/i, "A zone id is 32 hex characters").describe("The zone id from zones.list")
const accountId = z.string().regex(/^[a-f0-9]{32}$/i, "An account id is 32 hex characters").describe("The account id from accounts.list")
const recordId = z.string().regex(/^[a-f0-9]{32}$/i, "A DNS record id is 32 hex characters").describe("The record id from dnsRecords.list")
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(5).max(100).optional() }
const recordType = z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR", "HTTPS", "SVCB"])

const zone = z.looseObject({ id: z.string(), name: z.string().optional(), status: z.string().optional(), paused: z.boolean().optional(), type: z.string().optional(), name_servers: z.array(z.string()).optional() })
const record = z.looseObject({ id: z.string(), type: z.string().optional(), name: z.string().optional(), content: z.string().optional(), ttl: z.number().optional(), proxied: z.boolean().optional(), comment: z.string().nullish() })
const envelope = <T extends z.ZodType>(result: T) => z.looseObject({ success: z.boolean().optional(), result })
const pages = offsetPagination({ itemsKey: "result", unit: "page", pageSizeParam: "per_page", totalPath: ["result_info", "total_count"], defaultPageSize: 20, maxPageSize: 100 })

const recordFields = {
  type: recordType,
  name: z.string().min(1).max(255).describe('The record name, such as "www" or "www.example.com"; "@" is the zone apex'),
  content: z.string().min(1).describe("The record value: an IP address for A and AAAA, a hostname for CNAME, text for TXT"),
  ttl: z.number().int().min(1).max(86400).optional().describe("Seconds; 1 means automatic. Default: automatic"),
  proxied: z.boolean().optional().describe("Send traffic through Cloudflare (only for A, AAAA and CNAME)"),
  comment: z.string().max(100).optional(),
  priority: z.number().int().min(0).max(65535).optional().describe("Required for MX records"),
}

export const cloudflare = defineConnector({
  name: "cloudflare",
  baseUrl: "https://api.cloudflare.com/client/v4",
  auth: { type: "bearer" },
  meta: {
    title: "Cloudflare",
    description: "Manage Cloudflare zones, DNS records and the cache, and list accounts and Workers scripts with a scoped API token.",
    docsUrl: "https://developers.cloudflare.com/api/",
    status: "docs-based",
    credentialEnv: "CLOUDFLARE_API_TOKEN",
  },
  actions: {
    "token.verify": {
      description: "Check that the API token is valid and active. Use this first when something fails with an authentication error.",
      method: "GET",
      path: "/user/tokens/verify",
      input: z.object({}),
      output: envelope(z.looseObject({ id: z.string().optional(), status: z.string().optional() })),
      effect: "read",
    },
    "accounts.list": {
      description: "List the Cloudflare accounts the token can see. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/accounts",
      input: z.object({ ...paging }),
      output: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })),
      effect: "read",
      paginate: pages,
    },
    "zones.list": {
      description: "List zones (domains) the token can see, optionally filtered by name, status or account. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/zones",
      input: z.object({ name: z.string().optional().describe('A domain, such as "example.com"'), status: z.enum(["initializing", "pending", "active", "moved"]).optional(), accountId: accountId.optional(), ...paging }),
      output: z.array(zone),
      effect: "read",
      buildQuery: (i) => ({ ...(i.name !== undefined && { name: i.name }), ...(i.status !== undefined && { status: i.status }), ...(i.accountId !== undefined && { "account.id": i.accountId }) }),
      paginate: pages,
    },
    "zone.get": {
      description: "Get a zone by id: its status, name servers and plan.",
      method: "GET",
      path: "/zones/{zoneId}",
      input: z.object({ zoneId }),
      output: envelope(zone),
      effect: "read",
    },
    "zoneSettings.list": {
      description: "List a zone's settings (SSL mode, minimum TLS version, always-use-HTTPS, caching level and more) with their current values.",
      method: "GET",
      path: "/zones/{zoneId}/settings",
      input: z.object({ zoneId }),
      output: envelope(z.array(z.looseObject({ id: z.string(), value: z.unknown().optional(), editable: z.boolean().optional() }))),
      effect: "read",
    },
    "dnsRecords.list": {
      description: "List a zone's DNS records, optionally filtered by type, name or content. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/zones/{zoneId}/dns_records",
      input: z.object({ zoneId, type: recordType.optional(), name: z.string().optional().describe("The full record name, such as www.example.com"), content: z.string().optional(), ...paging }),
      output: z.array(record),
      effect: "read",
      buildQuery: (i) => ({ ...(i.type !== undefined && { type: i.type }), ...(i.name !== undefined && { name: i.name }), ...(i.content !== undefined && { content: i.content }) }),
      paginate: pages,
    },
    "dnsRecord.get": {
      description: "Get one DNS record by id, with its type, name, content, TTL and whether it is proxied.",
      method: "GET",
      path: "/zones/{zoneId}/dns_records/{recordId}",
      input: z.object({ zoneId, recordId }),
      output: envelope(record),
      effect: "read",
    },
    "dnsRecord.create": {
      description: "Create a DNS record. A wrong record can take a live site or mailbox offline: ask a human first.",
      method: "POST",
      path: "/zones/{zoneId}/dns_records",
      input: z.object({ zoneId, ...recordFields }).refine((i) => i.type !== "MX" || i.priority !== undefined, { message: "An MX record needs a priority" }),
      output: envelope(record),
      effect: "write",
      buildBody: (i) => {
        const { zoneId: _zone, ...rest } = i
        return rest
      },
    },
    "dnsRecord.update": {
      description: "Change fields of an existing DNS record (only the fields you give). This changes live traffic within minutes: ask a human first.",
      method: "PATCH",
      path: "/zones/{zoneId}/dns_records/{recordId}",
      input: z.object({ zoneId, recordId, type: recordType.optional(), name: recordFields.name.optional(), content: recordFields.content.optional(), ttl: recordFields.ttl, proxied: recordFields.proxied, comment: recordFields.comment, priority: recordFields.priority }),
      output: envelope(record),
      effect: "write",
      buildBody: (i) => {
        const { zoneId: _zone, recordId: _record, ...rest } = i
        return rest
      },
    },
    "dnsRecord.delete": {
      description: "Delete a DNS record. The name stops resolving to it within minutes and the record cannot be restored: ask a human first.",
      method: "DELETE",
      path: "/zones/{zoneId}/dns_records/{recordId}",
      input: z.object({ zoneId, recordId }),
      output: envelope(z.looseObject({ id: z.string().optional() })),
      effect: "destructive",
    },
    "cache.purge": {
      description: "Purge cached content for a zone: everything, or only the given URLs, hosts, tags or prefixes. Visitors then hit the origin, which can cause a traffic spike. Give exactly one option; ask a human first.",
      method: "POST",
      path: "/zones/{zoneId}/purge_cache",
      input: z
        .object({
          zoneId,
          purgeEverything: z.literal(true).optional().describe("Purge every cached file in the zone"),
          files: z.array(z.string().url()).min(1).max(30).optional().describe("Full URLs to purge"),
          hosts: z.array(z.string().min(1)).min(1).max(30).optional(),
          tags: z.array(z.string().min(1)).min(1).max(30).optional().describe("Cache-Tag values (Enterprise)"),
          prefixes: z.array(z.string().min(1)).min(1).max(30).optional().describe('URL prefixes without a scheme, such as "example.com/images/"'),
        })
        .refine((i) => [i.purgeEverything, i.files, i.hosts, i.tags, i.prefixes].filter((v) => v !== undefined).length === 1, { message: "Give exactly one of purgeEverything, files, hosts, tags or prefixes" }),
      output: envelope(z.looseObject({ id: z.string().optional() })),
      effect: "destructive",
      buildBody: (i) => {
        const { zoneId: _zone, purgeEverything, ...rest } = i
        return { ...rest, ...(purgeEverything !== undefined && { purge_everything: purgeEverything }) }
      },
    },
    "workers.list": {
      description: "List the Workers scripts in an account, with when each was last modified.",
      method: "GET",
      path: "/accounts/{accountId}/workers/scripts",
      input: z.object({ accountId }),
      output: envelope(z.array(z.looseObject({ id: z.string(), modified_on: z.string().optional(), created_on: z.string().optional() }))),
      effect: "read",
    },
  },
})

export default cloudflare
