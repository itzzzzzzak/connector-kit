import { bodyCursorPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Calendly's official OpenAPI spec (developer.calendly.com/openapi/calendly-api.yaml): base URL,
// paths, `collection` + `pagination.next_page_token` (sent back as `page_token`, page size is `count`), and
// from Calendly's OAuth discovery document (calendly.com/.well-known/oauth-authorization-server): endpoints, PKCE S256.
// Calendly identifies users and organizations by URI, e.g. https://api.calendly.com/users/AAAA.

const uri = z.string()
const user = z.object({
  uri,
  name: z.string().nullish(),
  slug: z.string().optional(),
  email: z.string().optional(),
  scheduling_url: z.string().optional(),
  timezone: z.string().optional(),
  current_organization: z.string().optional(),
})
const eventType = z.object({
  uri,
  name: z.string().nullish(),
  active: z.boolean().optional(),
  slug: z.string().nullish(),
  duration: z.number().optional(),
  kind: z.string().optional(),
  scheduling_url: z.string().optional(),
  description_plain: z.string().nullish(),
})
const scheduledEvent = z.object({
  uri,
  name: z.string().nullish(),
  status: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  event_type: z.string().optional(),
  location: z.unknown().optional(),
  invitees_counter: z.object({ total: z.number(), active: z.number(), limit: z.number() }).optional(),
  event_memberships: z.array(z.object({ user: z.string().optional(), user_email: z.string().optional(), user_name: z.string().optional() })).optional(),
})
const invitee = z.object({
  uri,
  email: z.string(),
  name: z.string().optional(),
  status: z.string(),
  timezone: z.string().nullish(),
  event: z.string().optional(),
  created_at: z.string().optional(),
  cancel_url: z.string().optional(),
  reschedule_url: z.string().optional(),
})

const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = () => bodyCursorPagination({ itemsKey: "collection", cursorPath: ["pagination", "next_page_token"], cursorParam: "page_token", pageSizeParam: "count", defaultPageSize: 20, maxPageSize: 100 })
const owner = {
  user: z.string().optional().describe("A user URI (from users.me). Give this or organization."),
  organization: z.string().optional().describe("An organization URI (users.me returns current_organization). Give this or user."),
}

export const calendly = defineConnector({
  name: "calendly",
  baseUrl: "https://api.calendly.com",
  // A personal access token works as a Bearer token; OAuth is for apps acting for many users.
  auth: { type: "oauth2", authorizeUrl: "https://calendly.com/oauth/authorize", tokenUrl: "https://calendly.com/oauth/token" },
  meta: {
    title: "Calendly",
    description: "Read the user's event types, scheduled meetings and invitees, and cancel meetings.",
    docsUrl: "https://developer.calendly.com/api-docs",
    status: "docs-based",
    credentialEnv: "CALENDLY_TOKEN",
  },
  actions: {
    "users.me": {
      description: "Get the authenticated Calendly user. Use first: it returns the user URI and organization URI that the other calls need.",
      method: "GET",
      path: "/users/me",
      input: z.object({}),
      output: z.object({ resource: user }),
      effect: "read",
    },
    "eventTypes.list": {
      description: "List event types (the kinds of meetings people can book, e.g. a 30-minute call). Give a user or organization URI. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/event_types",
      input: z.object({ ...owner, active: z.boolean().optional(), ...paging }),
      output: z.array(eventType),
      effect: "read",
      paginate: pagination(),
    },
    "scheduledEvents.list": {
      description: "List scheduled meetings. Use when the user asks what is on their calendar or who booked. Give a user (or organization) URI; filter by status or time range. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/scheduled_events",
      input: z.object({
        ...owner,
        status: z.enum(["active", "canceled"]).optional(),
        invitee_email: z.string().optional().describe("Only meetings with this invitee"),
        min_start_time: z.string().optional().describe("ISO 8601, only meetings starting at or after this"),
        max_start_time: z.string().optional().describe("ISO 8601, only meetings starting at or before this"),
        sort: z.string().optional().describe('For example "start_time:asc"'),
        ...paging,
      }),
      output: z.array(scheduledEvent),
      effect: "read",
      paginate: pagination(),
    },
    "scheduledEvents.get": {
      description: "Get one scheduled meeting by its uuid (the last part of its URI).",
      method: "GET",
      path: "/scheduled_events/{uuid}",
      input: z.object({ uuid: z.string() }),
      output: z.object({ resource: scheduledEvent }),
      effect: "read",
    },
    "scheduledEvents.invitees.list": {
      description: "List the people invited to a scheduled meeting, with their email and status. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/scheduled_events/{uuid}/invitees",
      input: z.object({ uuid: z.string(), status: z.enum(["active", "canceled"]).optional(), email: z.string().optional(), ...paging }),
      output: z.array(invitee),
      effect: "read",
      paginate: pagination(),
    },
    "scheduledEvents.cancel": {
      description: "CANCEL a scheduled meeting. This cancels it for everyone and notifies the invitees: only use when the user explicitly asked to cancel that meeting.",
      method: "POST",
      path: "/scheduled_events/{uuid}/cancellation",
      input: z.object({ uuid: z.string(), reason: z.string().max(10_000).optional().describe("Shown to the invitees") }),
      output: z.object({ resource: z.object({ canceled_by: z.string().optional(), reason: z.string().nullish(), canceler_type: z.string().optional(), created_at: z.string().optional() }) }),
      effect: "destructive",
    },
  },
})

export default calendly
