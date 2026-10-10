import { bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from DigitalOcean's official OpenAPI spec (github.com/digitalocean/openapi, bundled build) and its OAuth
// docs: base URL, paths, list envelopes (`droplets`, `domains`, `domain_records` + `links.pages.next`, a FULL url),
// OAuth endpoints, client credentials in the request body, single-use rotating refresh tokens, PKCE S256.

const droplet = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string().optional(),
  memory: z.number().optional(),
  vcpus: z.number().optional(),
  disk: z.number().optional(),
  locked: z.boolean().optional(),
  created_at: z.string().optional(),
  size_slug: z.string().optional(),
  region: z.object({ slug: z.string().optional(), name: z.string().optional() }).optional(),
  image: z.object({ id: z.number().optional(), name: z.string().nullish(), distribution: z.string().optional(), slug: z.string().nullish() }).optional(),
  tags: z.array(z.string()).optional(),
  networks: z.object({ v4: z.array(z.object({ ip_address: z.string(), type: z.string().optional() })).optional(), v6: z.array(z.object({ ip_address: z.string(), type: z.string().optional() })).optional() }).optional(),
})
const domain = z.object({ name: z.string(), ttl: z.number().nullish(), ip_address: z.string().nullish() })
const record = z.object({ id: z.number().optional(), type: z.string(), name: z.string().optional(), data: z.string().nullish(), priority: z.number().nullish(), port: z.number().nullish(), ttl: z.number().optional(), weight: z.number().nullish() })

const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = (itemsKey: string) => bodyLinkPagination({ itemsKey, nextUrlPath: ["links", "pages", "next"], pageSizeParam: "per_page", defaultPageSize: 30, maxPageSize: 200 })

export const digitalocean = defineConnector({
  name: "digitalocean",
  baseUrl: "https://api.digitalocean.com/v2",
  // A personal access token works as a Bearer token; OAuth is for apps acting for many DigitalOcean users.
  auth: { type: "oauth2", authorizeUrl: "https://cloud.digitalocean.com/v1/oauth/authorize", tokenUrl: "https://cloud.digitalocean.com/v1/oauth/token", scopes: ["read"] },
  meta: {
    title: "DigitalOcean",
    description: "Read account details, droplets (servers), domains and DNS records.",
    docsUrl: "https://docs.digitalocean.com/reference/api/",
    status: "docs-based",
    credentialEnv: "DIGITALOCEAN_TOKEN",
  },
  actions: {
    "account.get": {
      description: "Get the DigitalOcean account: email, status, and the droplet limit. Use to check the token works and what the account may create.",
      method: "GET",
      path: "/account",
      input: z.object({}),
      output: z.object({ account: z.object({ email: z.string(), uuid: z.string(), status: z.string().optional(), status_message: z.string().optional(), droplet_limit: z.number().optional(), email_verified: z.boolean().optional(), name: z.string().optional(), team: z.object({ uuid: z.string().optional(), name: z.string().optional() }).optional() }) }),
      effect: "read",
    },
    "droplets.list": {
      description: "List droplets (virtual servers) with their status, size, region and IP addresses. Use when the user asks what servers they run. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/droplets",
      input: z.object({ tag_name: z.string().optional().describe("Only droplets with this tag"), name: z.string().optional().describe("Only the droplet with this exact name"), ...paging }),
      output: z.array(droplet),
      effect: "read",
      paginate: pagination("droplets"),
    },
    "droplets.get": {
      description: "Get one droplet by its numeric id: status, size, region, image, tags and IP addresses.",
      method: "GET",
      path: "/droplets/{droplet_id}",
      input: z.object({ droplet_id: z.number().int().positive() }),
      output: z.object({ droplet }),
      effect: "read",
    },
    "domains.list": {
      description: "List the domains managed in DigitalOcean DNS. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/domains",
      input: z.object({ ...paging }),
      output: z.array(domain),
      effect: "read",
      paginate: pagination("domains"),
    },
    "domains.records.list": {
      description: "List the DNS records of one domain (A, AAAA, CNAME, MX, TXT...). Optionally filter by record type or name. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/domains/{domain_name}/records",
      input: z.object({ domain_name: z.string(), type: z.enum(["A", "AAAA", "CAA", "CNAME", "MX", "NS", "SOA", "SRV", "TXT"]).optional(), name: z.string().optional().describe("Fully qualified record name, e.g. www.example.com"), ...paging }),
      output: z.array(record),
      effect: "read",
      paginate: pagination("domain_records"),
    },
  },
})

export default digitalocean
