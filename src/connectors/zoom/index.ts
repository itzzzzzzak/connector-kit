import { bodyCursorPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Zoom's official Meetings OpenAPI spec (developers.zoom.us) and Zoom's OAuth page: base URL
// https://api.zoom.us/v2, `userId` may be "me", `next_page_token` / `page_size` pagination, OAuth endpoints,
// confidential clients authenticate with HTTP Basic, one-hour access tokens, rotating refresh tokens.
//
// PRIVACY BY OMISSION: Zoom returns meeting passcodes, a host `start_url` (which logs in as the host) and recording
// download URLs. None of them appear in these schemas, and the kit drops unknown fields, so neither an app
// nor a model ever receives them. Add a field here deliberately if you need it.

const meeting = z.object({
  id: z.number(),
  uuid: z.string().optional(),
  topic: z.string().optional(),
  type: z.number().optional().describe("1 instant, 2 scheduled, 3 recurring (no fixed time), 8 recurring (fixed time)"),
  start_time: z.string().optional(),
  duration: z.number().optional().describe("Minutes"),
  timezone: z.string().optional(),
  agenda: z.string().optional(),
  created_at: z.string().optional(),
  join_url: z.string().optional(),
  host_id: z.string().optional(),
  host_email: z.string().optional(),
})
const recordedMeeting = z.object({
  id: z.number().optional(),
  uuid: z.string().optional(),
  topic: z.string().optional(),
  start_time: z.string().optional(),
  duration: z.number().optional(),
  total_size: z.number().optional(),
  recording_count: z.number().optional(),
  recording_files: z
    .array(z.object({ id: z.string().optional(), file_type: z.string().optional(), file_extension: z.string().optional(), file_size: z.number().optional(), recording_type: z.string().optional(), recording_start: z.string().optional(), recording_end: z.string().optional(), status: z.string().optional() }))
    .optional(),
})

const user = z.string().default("me").describe('A Zoom user id or email, or "me" for the authenticated user')
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = () => bodyCursorPagination({ itemsKey: "meetings", cursorPath: ["next_page_token"], cursorParam: "next_page_token", pageSizeParam: "page_size", defaultPageSize: 30, maxPageSize: 300 })

export const zoom = defineConnector({
  name: "zoom",
  baseUrl: "https://api.zoom.us/v2",
  // An OAuth access token (or a Server-to-Server OAuth token) is sent as a Bearer token. Scopes are configured on the
  // Zoom app itself, so none are requested here. Confidential clients use HTTP Basic at the token endpoint; PKCE is
  // documented for public clients, which send no secret, so it is off.
  auth: { type: "oauth2", authorizeUrl: "https://zoom.us/oauth/authorize", tokenUrl: "https://zoom.us/oauth/token", clientAuth: "basic", pkce: false },
  meta: {
    title: "Zoom",
    description: "List and read the user's meetings, create meetings, and list cloud recordings (no passcodes or download links are exposed).",
    docsUrl: "https://developers.zoom.us/docs/api/meetings/",
    status: "docs-based",
    credentialEnv: "ZOOM_TOKEN",
  },
  actions: {
    "meetings.list": {
      description: "List a user's meetings. Use when the user asks what meetings they have scheduled, are live, or had. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/{userId}/meetings",
      input: z.object({
        userId: user,
        type: z.enum(["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"]).optional().describe("Default: scheduled"),
        from: z.string().optional().describe("yyyy-MM-dd, for previous meetings"),
        to: z.string().optional().describe("yyyy-MM-dd, for previous meetings"),
        ...paging,
      }),
      output: z.array(meeting),
      effect: "read",
      paginate: pagination(),
    },
    "meetings.get": {
      description: "Get one meeting by its numeric id: topic, time, duration, agenda and join link.",
      method: "GET",
      path: "/meetings/{meetingId}",
      input: z.object({ meetingId: z.number().int().positive() }),
      output: meeting,
      effect: "read",
    },
    "meetings.create": {
      description: "Create a Zoom meeting. This CREATES A MEETING on the user's account (it does not email anyone): only use when they clearly asked. Returns the join link.",
      method: "POST",
      path: "/users/{userId}/meetings",
      input: z.object({
        userId: user,
        topic: z.string().min(1).max(200),
        type: z.union([z.literal(1), z.literal(2)]).default(2).describe("1 = instant meeting, 2 = scheduled meeting"),
        start_time: z.string().optional().describe("ISO 8601, for a scheduled meeting, e.g. 2026-11-01T10:00:00Z"),
        duration: z.number().int().positive().max(1440).optional().describe("Minutes"),
        timezone: z.string().optional().describe("For example Europe/London"),
        agenda: z.string().max(2000).optional(),
      }),
      output: meeting,
      effect: "write",
    },
    "recordings.list": {
      description: "List a user's cloud recordings in a date range (default: the last day). Returns file types and sizes, not download links. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/{userId}/recordings",
      input: z.object({ userId: user, from: z.string().optional().describe("yyyy-MM-dd"), to: z.string().optional().describe("yyyy-MM-dd"), ...paging }),
      output: z.array(recordedMeeting),
      effect: "read",
      paginate: pagination(),
    },
  },
})

export default zoom
