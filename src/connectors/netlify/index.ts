import { defineConnector, linkHeaderPagination } from "../../index.js"
import { z } from "zod"

// Facts from Netlify's official OpenAPI (Swagger 2) spec (open-api.netlify.com) and its API guide: base URL
// https://api.netlify.com/api/v1, Bearer personal access token, `page`/`per_page` with a Link header (default and
// maximum 100 per page), rate limit 500 requests/minute with X-RateLimit-* headers. The spec declares only an
// implicit OAuth flow, which this library does not use, so this connector takes a personal access token.

const deploy = z.object({
  id: z.string(),
  site_id: z.string().optional(),
  state: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  ssl_url: z.string().optional(),
  admin_url: z.string().optional(),
  deploy_ssl_url: z.string().optional(),
  branch: z.string().nullish(),
  commit_ref: z.string().nullish(),
  commit_url: z.string().nullish(),
  title: z.string().nullish(),
  context: z.string().optional(),
  error_message: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  published_at: z.string().nullish(),
})
const site = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string().optional(),
  url: z.string().optional(),
  ssl_url: z.string().optional(),
  admin_url: z.string().optional(),
  custom_domain: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  published_deploy: deploy.partial().optional(),
})

const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = () => linkHeaderPagination({ pageSizeParam: "per_page", defaultPageSize: 30, maxPageSize: 100 })

export const netlify = defineConnector({
  name: "netlify",
  baseUrl: "https://api.netlify.com/api/v1",
  auth: { type: "bearer" },
  meta: {
    title: "Netlify",
    description: "Read sites and deploys, and trigger a new build of a site.",
    docsUrl: "https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/",
    status: "docs-based",
    credentialEnv: "NETLIFY_TOKEN",
  },
  actions: {
    "user.get": {
      description: "Get the authenticated Netlify user (name, email, number of sites). Use to check the token works.",
      method: "GET",
      path: "/user",
      input: z.object({}),
      output: z.object({ id: z.string().optional(), full_name: z.string().nullish(), email: z.string().nullish(), site_count: z.number().optional(), last_login: z.string().nullish() }),
      effect: "read",
    },
    "sites.list": {
      description: "List the Netlify sites the token can see, with their URLs and state. Use when the user asks what sites they have. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/sites",
      input: z.object({ name: z.string().optional().describe("Filter by site name"), filter: z.enum(["all", "owner", "guest"]).optional(), ...paging }),
      output: z.array(site),
      effect: "read",
      paginate: pagination(),
    },
    "sites.get": {
      description: "Get one site by id (or by its domain, e.g. mysite.netlify.app): URL, custom domain, and the currently published deploy.",
      method: "GET",
      path: "/sites/{site_id}",
      input: z.object({ site_id: z.string() }),
      output: site,
      effect: "read",
    },
    "sites.deploys.list": {
      description: "List a site's deploys, newest first: state, branch, commit, and any error. Use when the user asks if a deploy worked or what was published. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/sites/{site_id}/deploys",
      input: z.object({
        site_id: z.string(),
        state: z.enum(["new", "pending_review", "accepted", "rejected", "enqueued", "building"]).optional(),
        branch: z.string().optional(),
        production: z.boolean().optional().describe("Only production deploys"),
        "deploy-previews": z.boolean().optional().describe("Only deploy previews"),
        ...paging,
      }),
      output: z.array(deploy),
      effect: "read",
      paginate: pagination(),
    },
    "deploys.get": {
      description: "Get one deploy by id: its state, branch, commit, URLs and error message if it failed.",
      method: "GET",
      path: "/deploys/{deploy_id}",
      input: z.object({ deploy_id: z.string() }),
      output: deploy,
      effect: "read",
    },
    "sites.builds.create": {
      description: "Trigger a NEW BUILD (and deploy) of a site from its repository. This uses the user's build minutes and can publish changes: only use when they clearly asked to rebuild or redeploy.",
      method: "POST",
      path: "/sites/{site_id}/builds",
      input: z.object({ site_id: z.string(), branch: z.string().optional(), clear_cache: z.boolean().optional().describe("Rebuild without the build cache"), title: z.string().max(200).optional() }),
      output: z.object({ id: z.string().optional(), deploy_id: z.string().optional(), sha: z.string().nullish(), done: z.boolean().optional(), error: z.string().nullish(), created_at: z.string().optional() }),
      effect: "write",
      buildQuery: (input) => input, // Netlify takes these as query parameters, with no body
    },
  },
})

export default netlify
