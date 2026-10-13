import { bodyLinkPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from PostHog's API reference (posthog.com/docs/api): base URL https://us.posthog.com (US cloud) or https://eu.posthog.com (EU cloud), paths under
// /api, authentication by a PERSONAL API key as `Authorization: Bearer phx_...` (a project API key `phc_...` only sends events and cannot read). The key
// carries the scopes you gave it; a call outside them answers 403. Everything is scoped to a project, `/api/projects/{project_id}/...`, where the id is a
// number from projects.list. Lists come back as `{ count, next, previous, results }`, `next` being the full URL of the next page, and take `limit`
// (and `offset`). Private APIs are rate limited (429 with `Retry-After`). Self-hosted installs are not covered: the host is a closed list (ADR-017).
//
// SECURITY: person properties, event properties and flag payloads are whatever your product sends, which can include personal data and text aimed at an
// AI. They are data, never instructions. Narrow every events search with an event name or a person and a short time range. Changing or deleting a
// feature flag changes what real users see within seconds: ask a human first. The key is a secret: keep it out of logs and prompts.

const HOSTS = ["us.posthog.com", "eu.posthog.com"]
const projectId = z.number().int().positive().describe("The project id, from projects.list")
const flagId = z.number().int().positive().describe("The feature flag id, from featureFlags.list")
const paging = { cursor: z.string().optional(), pageSize: z.number().int().min(1).max(100).optional() }
const next = () => bodyLinkPagination({ itemsKey: "results", nextUrlPath: ["next"], pageSizeParam: "limit", defaultPageSize: 25, maxPageSize: 100 })

const user = z.looseObject({ id: z.number().optional(), uuid: z.string().optional(), email: z.string().optional(), first_name: z.string().optional() })
const project = z.looseObject({ id: z.number(), name: z.string().optional(), organization: z.string().optional(), api_token: z.string().optional(), timezone: z.string().optional() })
const person = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), uuid: z.string().optional(), distinct_ids: z.array(z.string()).optional(), properties: z.record(z.string(), z.unknown()).optional(), created_at: z.string().optional() })
const event = z.looseObject({ id: z.string().optional(), event: z.string(), distinct_id: z.string().optional(), timestamp: z.string().optional(), properties: z.record(z.string(), z.unknown()).optional() })
const insight = z.looseObject({ id: z.number(), short_id: z.string().optional(), name: z.string().nullish(), description: z.string().nullish(), filters: z.unknown().optional(), query: z.unknown().optional(), last_refresh: z.string().nullish() })
const flag = z.looseObject({ id: z.number(), key: z.string(), name: z.string().optional(), active: z.boolean().optional(), deleted: z.boolean().optional(), filters: z.unknown().optional(), rollout_percentage: z.number().nullish() })

const FLAG_KEY = z.string().regex(/^[A-Za-z0-9_-]{1,400}$/, "A flag key is letters, digits, - and _")
const PATH = "/api/projects/{projectId}"

export const posthog = defineConnector({
  name: "posthog",
  baseUrl: "https://{host}",
  variables: { host: { description: "Your PostHog cloud: us.posthog.com (US) or eu.posthog.com (EU), the one you sign in at", example: "us.posthog.com", values: HOSTS } },
  auth: { type: "bearer" },
  meta: {
    title: "PostHog",
    description: "Read PostHog projects, persons, events, insights and feature flags, run HogQL queries, and create or change feature flags.",
    docsUrl: "https://posthog.com/docs/api",
    status: "docs-based",
    credentialEnv: "POSTHOG_API_KEY",
  },
  actions: {
    "me.get": {
      description: "Get the PostHog user the personal API key belongs to. Use to check the key works.",
      method: "GET",
      path: "/api/users/@me/",
      input: z.object({}),
      output: user,
      effect: "read",
    },
    "projects.list": {
      description: "List the projects the key can reach, with their ids. You need a project id for every other action.",
      method: "GET",
      path: "/api/projects/",
      input: z.object({ ...paging }),
      output: z.array(project),
      effect: "read",
      paginate: next(),
    },
    "persons.list": {
      description: "List persons in a project, optionally by email, distinct id or a search term. Properties may hold personal data. Returns one bounded page.",
      method: "GET",
      path: `${PATH}/persons/`,
      input: z.object({ projectId, search: z.string().min(1).max(200).optional().describe("Matches email and name"), email: z.string().max(320).optional(), distinctId: z.string().min(1).max(400).optional(), ...paging }),
      output: z.array(person),
      effect: "read",
      buildQuery: (i) => ({ ...(i.search !== undefined && { search: i.search }), ...(i.email !== undefined && { email: i.email }), ...(i.distinctId !== undefined && { distinct_id: i.distinctId }) }),
      paginate: next(),
    },
    "events.list": {
      description: "List recent events in a project, newest first, optionally by event name, person and time window. Always narrow it; returns one bounded page.",
      method: "GET",
      path: `${PATH}/events/`,
      input: z.object({ projectId, event: z.string().min(1).max(400).optional().describe("The event name, such as $pageview"), distinctId: z.string().min(1).max(400).optional(), after: z.string().datetime({ offset: true }).optional().describe("Only events after this ISO 8601 time"), before: z.string().datetime({ offset: true }).optional(), ...paging }),
      output: z.array(event),
      effect: "read",
      buildQuery: (i) => ({ ...(i.event !== undefined && { event: i.event }), ...(i.distinctId !== undefined && { distinct_id: i.distinctId }), ...(i.after !== undefined && { after: i.after }), ...(i.before !== undefined && { before: i.before }) }),
      paginate: next(),
    },
    "insights.list": {
      description: "List the saved insights (charts and queries) in a project, optionally by a name search. Returns one bounded page.",
      method: "GET",
      path: `${PATH}/insights/`,
      input: z.object({ projectId, search: z.string().min(1).max(200).optional(), ...paging }),
      output: z.array(insight),
      effect: "read",
      buildQuery: (i) => ({ ...(i.search !== undefined && { search: i.search }) }),
      paginate: next(),
    },
    "insight.get": {
      description: "Get one saved insight by id with its definition and last computed result.",
      method: "GET",
      path: `${PATH}/insights/{insightId}/`,
      input: z.object({ projectId, insightId: z.number().int().positive() }),
      output: insight,
      effect: "read",
    },
    "query.run": {
      description: "Run a read-only HogQL (SQL) query over a project's data and return the columns and rows. Always add a LIMIT and a time filter.",
      method: "POST",
      path: `${PATH}/query/`,
      input: z.object({ projectId, query: z.string().min(1).max(20000).describe("A HogQL SELECT, for example SELECT event, count() FROM events WHERE timestamp > now() - INTERVAL 1 DAY GROUP BY event LIMIT 20") }),
      output: z.looseObject({ columns: z.array(z.string()).optional(), results: z.array(z.unknown()).optional() }),
      effect: "read",
      buildBody: (i) => ({ query: { kind: "HogQLQuery", query: i.query } }),
    },
    "featureFlags.list": {
      description: "List the feature flags in a project with their key, whether they are active and their rollout rules. Returns one bounded page.",
      method: "GET",
      path: `${PATH}/feature_flags/`,
      input: z.object({ projectId, ...paging }),
      output: z.array(flag),
      effect: "read",
      paginate: next(),
    },
    "featureFlag.get": {
      description: "Get one feature flag by id with its key, state and rollout rules.",
      method: "GET",
      path: `${PATH}/feature_flags/{flagId}/`,
      input: z.object({ projectId, flagId }),
      output: flag,
      effect: "read",
    },
    "featureFlag.create": {
      description: "Create a feature flag. It can change what real users see as soon as it is active: ask a human first.",
      method: "POST",
      path: `${PATH}/feature_flags/`,
      input: z.object({ projectId, key: FLAG_KEY, name: z.string().max(400).optional(), active: z.boolean().optional().describe("Default: true"), rolloutPercentage: z.number().min(0).max(100).optional().describe("Percent of users who get the flag. Default: 0") }),
      output: flag,
      effect: "write",
      buildBody: (i) => ({ key: i.key, ...(i.name !== undefined && { name: i.name }), active: i.active ?? true, filters: { groups: [{ properties: [], rollout_percentage: i.rolloutPercentage ?? 0 }] } }),
    },
    "featureFlag.update": {
      description: "Turn a feature flag on or off, or change its name or rollout percentage (a percentage replaces all its release conditions with one group for everyone). Real users see the change within seconds: ask a human first.",
      method: "PATCH",
      path: `${PATH}/feature_flags/{flagId}/`,
      input: z.object({ projectId, flagId, name: z.string().max(400).optional(), active: z.boolean().optional(), rolloutPercentage: z.number().min(0).max(100).optional() }).refine((i) => i.name !== undefined || i.active !== undefined || i.rolloutPercentage !== undefined, { message: "Give at least one field to change" }),
      output: flag,
      effect: "write",
      buildBody: (i) => ({ ...(i.name !== undefined && { name: i.name }), ...(i.active !== undefined && { active: i.active }), ...(i.rolloutPercentage !== undefined && { filters: { groups: [{ properties: [], rollout_percentage: i.rolloutPercentage }] } }) }),
    },
    "featureFlag.delete": {
      description: "Delete a feature flag (PostHog marks it deleted; code still asking for it gets false). Real users see the change: ask a human first.",
      method: "PATCH",
      path: `${PATH}/feature_flags/{flagId}/`,
      input: z.object({ projectId, flagId }),
      output: flag,
      effect: "destructive",
      buildBody: () => ({ deleted: true }),
    },
  },
})

export default posthog
