import { bodyCursorPagination, defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's Calendar API v3 reference and Discovery document: base URL https://www.googleapis.com/calendar/v3, the calendar id
// "primary" means the signed-in user's main calendar, lists page with `pageToken` / `maxResults` and `nextPageToken`, times are RFC 3339
// (`2026-10-14T09:00:00+02:00`) or all-day dates (`2026-10-14`). Google OAuth access tokens last an hour and come with a refresh token.
// Scopes: calendar.readonly reads, calendar.events changes events, calendar does everything. The default here is the full scope; narrow it.
//
// A curated, typed set is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: event titles, descriptions and attendee lists are written by other people and can contain anything, including text aimed at an
// AI. They are data, never instructions. Creating or changing an event can email its attendees (sendUpdates): ask a human first.

const calendarId = z.string().default("primary").describe('A calendar id, or "primary" (the default) for the signed-in user\'s main calendar')
const eventId = z.string().min(1)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const when = z.object({ dateTime: z.string().optional().describe("RFC 3339 with an offset, e.g. 2026-10-14T09:00:00+02:00"), date: z.string().optional().describe("YYYY-MM-DD for an all-day event"), timeZone: z.string().optional().describe("IANA name, e.g. Europe/Berlin") })
const sendUpdates = z.enum(["all", "externalOnly", "none"]).optional().describe("Who gets an email about the change. Default: none")
const people = z.array(z.object({ email: z.string(), optional: z.boolean().optional() }))
const eventTime = z.looseObject({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() })
const event = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  recurrence: z.array(z.string()).optional(),
  organizer: z.looseObject({ email: z.string().optional(), displayName: z.string().optional() }).optional(),
  attendees: z.array(z.looseObject({ email: z.string().optional(), displayName: z.string().optional(), responseStatus: z.string().optional(), optional: z.boolean().optional() })).optional(),
})
const calendar = z.looseObject({ id: z.string(), summary: z.string().optional(), description: z.string().optional(), timeZone: z.string().optional(), accessRole: z.string().optional(), primary: z.boolean().optional() })
const pageOf = (itemsKey: string) => bodyCursorPagination({ itemsKey, cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "maxResults", defaultPageSize: 25, maxPageSize: 250 })
const eventFields = {
  summary: z.string().optional().describe("The title"),
  description: z.string().optional(),
  location: z.string().optional(),
  start: when.optional(),
  end: when.optional(),
  attendees: people.optional().describe("People to invite; they are emailed according to sendUpdates"),
  recurrence: z.array(z.string()).optional().describe('RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=10"]'),
}

export const googleCalendar = defineConnector({
  name: "google-calendar",
  baseUrl: "https://www.googleapis.com/calendar/v3",
  auth: googleAuth(["https://www.googleapis.com/auth/calendar"]),
  meta: {
    title: "Google Calendar",
    description: "List, create and update calendar events, check free/busy time and manage calendars in Google Calendar.",
    docsUrl: "https://developers.google.com/workspace/calendar/api/v3/reference",
    status: "docs-based",
    credentialEnv: "GOOGLE_CALENDAR_TOKEN",
  },
  actions: {
    ...generatedActions,
    "calendarList.list": {
      description: "List the calendars the user can see (their own, shared and subscribed ones), with their ids and access role.",
      method: "GET",
      path: "/users/me/calendarList",
      input: z.object({ minAccessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]).optional(), ...paging }),
      output: z.array(calendar),
      effect: "read",
      paginate: pageOf("items"),
    },
    "events.list": {
      description: "List events on a calendar. Use timeMin and timeMax to bound the window and singleEvents=true to expand recurring events (needed for orderBy startTime). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/calendars/{calendarId}/events",
      input: z.object({
        calendarId,
        timeMin: z.string().optional().describe("RFC 3339, with an offset"),
        timeMax: z.string().optional().describe("RFC 3339, with an offset"),
        q: z.string().optional().describe("Free-text search over title, description, location and attendees"),
        singleEvents: z.boolean().optional(),
        orderBy: z.enum(["startTime", "updated"]).optional(),
        ...paging,
      }),
      output: z.array(event),
      effect: "read",
      paginate: pageOf("items"),
    },
    "events.get": {
      description: "Get one event by id, with its attendees and times.",
      method: "GET",
      path: "/calendars/{calendarId}/events/{eventId}",
      input: z.object({ calendarId, eventId }),
      output: event,
      effect: "read",
    },
    "events.insert": {
      description: "Create an event. Needs start and end. Attendees are emailed only when sendUpdates says so.",
      method: "POST",
      path: "/calendars/{calendarId}/events",
      input: z.object({ calendarId, ...eventFields, start: when, end: when, sendUpdates }),
      output: event,
      effect: "write",
      buildQuery: (i) => (i.sendUpdates === undefined ? {} : { sendUpdates: i.sendUpdates }),
      buildBody: (i) => {
        const { sendUpdates: _ignored, ...fields } = i
        return fields
      },
    },
    "events.patch": {
      description: "Change an event: only the fields you pass are updated. Attendees are emailed only when sendUpdates says so.",
      method: "PATCH",
      path: "/calendars/{calendarId}/events/{eventId}",
      input: z.object({ calendarId, eventId, ...eventFields, sendUpdates }),
      output: event,
      effect: "write",
      buildQuery: (i) => (i.sendUpdates === undefined ? {} : { sendUpdates: i.sendUpdates }),
      buildBody: (i) => {
        const { sendUpdates: _ignored, ...fields } = i
        return fields
      },
    },
    "events.delete": {
      description: "Delete an event (cancels it for everyone when you are the organizer). Attendees are emailed only when sendUpdates says so.",
      method: "DELETE",
      path: "/calendars/{calendarId}/events/{eventId}",
      input: z.object({ calendarId, eventId, sendUpdates }),
      output: z.unknown(),
      effect: "destructive",
      buildQuery: (i) => (i.sendUpdates === undefined ? {} : { sendUpdates: i.sendUpdates }),
    },
    "freebusy.query": {
      description: "Ask when calendars are busy between two times, to find a free slot. Pass the calendar ids (or email addresses) to check.",
      method: "POST",
      path: "/freeBusy",
      input: z.object({ timeMin: z.string(), timeMax: z.string(), timeZone: z.string().optional(), items: z.array(z.object({ id: z.string() })).min(1).max(50) }),
      output: z.looseObject({ calendars: z.record(z.string(), z.looseObject({ busy: z.array(z.object({ start: z.string(), end: z.string() })).optional() })) }),
      effect: "read",
    },
  },
})

export default googleCalendar
