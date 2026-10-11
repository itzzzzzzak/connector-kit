import { defineConnector, offsetPagination } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from PagerDuty's official REST API v2 OpenAPI (github.com/PagerDuty/api-schema): base URL
// https://api.pagerduty.com, `Authorization: Token token=<API key>`, `Accept: application/vnd.pagerduty+json;version=2`,
// classic offset paging (`limit`, `offset`, response `more`), array filters spelled `statuses[]`, `service_ids[]`, ...
//
// READ-ONLY on purpose: PagerDuty's write endpoints (acknowledge, resolve, create an incident) require a `From` header
// carrying the acting user's email on every request, which a connector cannot express yet. US region only (the EU
// service uses api.eu.pagerduty.com). Incident titles and notes can be written by monitoring tools or other people.

const ref = z.object({ id: z.string(), summary: z.string().optional(), html_url: z.string().optional() })
const incident = z.object({
  id: z.string(),
  incident_number: z.number().optional(),
  title: z.string().optional(),
  status: z.string().optional().describe("triggered, acknowledged or resolved"),
  urgency: z.string().optional().describe("high or low"),
  created_at: z.string().optional(),
  last_status_change_at: z.string().optional(),
  resolved_at: z.string().nullish(),
  incident_key: z.string().nullish(),
  html_url: z.string().optional(),
  service: ref.optional(),
  escalation_policy: ref.optional(),
  priority: ref.nullish(),
  assignments: z.array(z.object({ assignee: ref.optional() })).optional(),
})
const service = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().nullish(),
  status: z.string().optional().describe("active, warning, critical, maintenance or disabled"),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  last_incident_timestamp: z.string().nullish(),
  escalation_policy: ref.optional(),
})
const oncall = z.object({
  user: ref.optional(),
  schedule: ref.nullish(),
  escalation_policy: ref.optional(),
  escalation_level: z.number().optional(),
  start: z.string().nullish(),
  end: z.string().nullish(),
})
const schedule = z.object({ id: z.string(), name: z.string().optional(), description: z.string().nullish(), time_zone: z.string().optional(), html_url: z.string().optional() })
const escalationPolicy = z.object({ id: z.string(), name: z.string().optional(), description: z.string().nullish(), num_loops: z.number().optional(), html_url: z.string().optional() })
const user = z.object({ id: z.string(), name: z.string().optional(), email: z.string().optional(), role: z.string().optional(), job_title: z.string().nullish(), time_zone: z.string().optional(), html_url: z.string().optional() })

/** PagerDuty spells array filters `key[]=a&key[]=b`. */
const brackets = (...keys: string[]) => (input: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...input }
  for (const key of keys) {
    if (key in out) {
      out[`${key}[]`] = out[key]
      delete out[key]
    }
  }
  return out
}
const ids = (what: string) => z.array(z.string()).optional().describe(`Only ${what} with these ids`)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = (itemsKey: string) => offsetPagination({ itemsKey, hasMorePath: ["more"], pageSizeParam: "limit", defaultPageSize: 30, maxPageSize: 100 })

export const pagerduty = defineConnector({
  name: "pagerduty",
  baseUrl: "https://api.pagerduty.com",
  auth: { type: "apiKey", header: "Authorization", prefix: "Token token=" },
  defaultHeaders: { Accept: "application/vnd.pagerduty+json;version=2" },
  meta: {
    title: "PagerDuty",
    description: "Read incidents, services, on-call shifts, schedules and escalation policies (read-only, US region).",
    docsUrl: "https://developer.pagerduty.com/api-reference/",
    status: "docs-based",
    credentialEnv: "PAGERDUTY_TOKEN",
  },
  actions: {
    // The rest of the API, generated from the provider's official description (scripts/gen-openapi.mjs, ADR-018).
    ...generatedActions,
    // Hand-written actions come after, so they win over a generated action with the same name.
    "incidents.list": {
      description: "List incidents, newest first. Use when the user asks what is on fire, what is unresolved, or what happened. Filter by status, urgency, service or time. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/incidents",
      input: z.object({
        statuses: z.array(z.enum(["triggered", "acknowledged", "resolved"])).optional(),
        urgencies: z.array(z.enum(["high", "low"])).optional(),
        service_ids: ids("incidents on services"),
        team_ids: ids("incidents of teams"),
        user_ids: ids("incidents assigned to users"),
        since: z.string().optional().describe("ISO 8601 start of the time range"),
        until: z.string().optional().describe("ISO 8601 end of the time range"),
        ...paging,
      }),
      output: z.array(incident),
      effect: "read",
      paginate: pagination("incidents"),
      buildQuery: brackets("statuses", "urgencies", "service_ids", "team_ids", "user_ids"),
    },
    "incidents.get": {
      description: "Get one incident by id: title, status, urgency, service, escalation policy and who it is assigned to.",
      method: "GET",
      path: "/incidents/{id}",
      input: z.object({ id: z.string() }),
      output: z.object({ incident }),
      effect: "read",
    },
    "services.list": {
      description: "List services (the things that raise incidents) with their status. Use to find a service id or to see which services are in trouble. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/services",
      input: z.object({ query: z.string().optional().describe("Match service names"), team_ids: ids("services of teams"), ...paging }),
      output: z.array(service),
      effect: "read",
      paginate: pagination("services"),
      buildQuery: brackets("team_ids"),
    },
    "oncalls.list": {
      description: "List who is on call, with the schedule, escalation policy and shift times. Use when the user asks who is on call now. Set earliest:true to get only each person's next shift. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/oncalls",
      input: z.object({
        schedule_ids: ids("shifts on schedules"),
        escalation_policy_ids: ids("shifts under escalation policies"),
        user_ids: ids("shifts of users"),
        since: z.string().optional().describe("ISO 8601; with until, list shifts in this range"),
        until: z.string().optional(),
        earliest: z.boolean().optional().describe("Only the earliest shift per escalation level"),
        ...paging,
      }),
      output: z.array(oncall),
      effect: "read",
      paginate: pagination("oncalls"),
      buildQuery: brackets("schedule_ids", "escalation_policy_ids", "user_ids"),
    },
    "schedules.list": {
      description: "List on-call schedules, optionally filtered by name. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/schedules",
      input: z.object({ query: z.string().optional(), ...paging }),
      output: z.array(schedule),
      effect: "read",
      paginate: pagination("schedules"),
    },
    "escalationPolicies.list": {
      description: "List escalation policies (who gets paged, in what order), optionally filtered by name. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/escalation_policies",
      input: z.object({ query: z.string().optional(), ...paging }),
      output: z.array(escalationPolicy),
      effect: "read",
      paginate: pagination("escalation_policies"),
    },
    "users.list": {
      description: "List users in the PagerDuty account, optionally matching a name or email. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users",
      input: z.object({ query: z.string().optional(), team_ids: ids("users in teams"), ...paging }),
      output: z.array(user),
      effect: "read",
      paginate: pagination("users"),
      buildQuery: brackets("team_ids"),
    },
  },
})

export default pagerduty
