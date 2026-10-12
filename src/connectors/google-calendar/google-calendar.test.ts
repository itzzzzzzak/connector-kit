import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import calendar from "./index.js"

const event = { id: "e1", status: "confirmed", summary: "Standup", start: { dateTime: "2026-10-14T09:00:00+02:00" }, end: { dateTime: "2026-10-14T09:15:00+02:00" }, attendees: [{ email: "bob@acme.dev", responseStatus: "needsAction" }] }
const when = { dateTime: "2026-10-14T09:00:00+02:00", timeZone: "Europe/Berlin" }

standardTests(calendar, { action: "calendarList.list", input: {}, ok: { items: [{ id: "primary", summary: "Ada", primary: true }] }, badInput: { minAccessRole: "boss" } })
standardTests(calendar, { action: "events.list", input: { timeMin: "2026-10-14T00:00:00Z" }, ok: { items: [event], nextPageToken: "p2" }, badInput: { orderBy: "random" } })
standardTests(calendar, { action: "events.get", input: { eventId: "e1" }, ok: event, badInput: { eventId: "" } })
standardTests(calendar, { action: "events.insert", input: { summary: "Standup", start: when, end: when }, ok: event, badInput: { summary: "Standup" } })
standardTests(calendar, { action: "events.patch", input: { eventId: "e1", summary: "Renamed" }, ok: event, badInput: { eventId: "e1", attendees: "bob" } })
standardTests(calendar, { action: "events.delete", input: { eventId: "e1" }, ok: {}, badInput: { eventId: "" } })
standardTests(calendar, { action: "freebusy.query", input: { timeMin: "2026-10-14T00:00:00Z", timeMax: "2026-10-15T00:00:00Z", items: [{ id: "primary" }] }, ok: { calendars: { primary: { busy: [{ start: "2026-10-14T09:00:00Z", end: "2026-10-14T10:00:00Z" }] } } }, badInput: { timeMin: "a", timeMax: "b", items: [] } })

test("events go to the primary calendar by default, and a calendar id with an @ is encoded", async () => {
  const { conn, calls } = harness(calendar, () => json({ items: [] }))
  await conn.execute("events.list", {})
  assert.equal(calls[0]!.url.pathname, "/calendar/v3/calendars/primary/events")
  await conn.execute("events.list", { calendarId: "team@group.calendar.google.com", singleEvents: true, orderBy: "startTime", timeMin: "2026-10-14T00:00:00Z", pageSize: 50 })
  assert.equal(calls[1]!.url.pathname, "/calendar/v3/calendars/team%40group.calendar.google.com/events")
  assert.equal(calls[1]!.url.searchParams.get("singleEvents"), "true")
  assert.equal(calls[1]!.url.searchParams.get("orderBy"), "startTime")
  assert.equal(calls[1]!.url.searchParams.get("maxResults"), "50")
})

test("creating an event sends the fields in the body and sendUpdates in the query, not the other way round", async () => {
  const { conn, calls } = harness(calendar, () => json(event))
  await conn.execute("events.insert", { summary: "Standup", start: when, end: when, attendees: [{ email: "bob@acme.dev" }], sendUpdates: "all" })
  assert.equal(calls[0]!.url.searchParams.get("sendUpdates"), "all")
  assert.deepEqual(calls[0]!.body, { summary: "Standup", start: when, end: when, attendees: [{ email: "bob@acme.dev" }] })
  await conn.execute("events.insert", { summary: "Quiet", start: when, end: when })
  assert.equal(calls[1]!.url.searchParams.has("sendUpdates"), false)
})

test("deleting an event is destructive and sends no body", async () => {
  const { conn, calls } = harness(calendar, () => new Response(null, { status: 204 }))
  await conn.execute("events.delete", { eventId: "e1", sendUpdates: "none" })
  assert.equal(calls[0]!.init.method, "DELETE")
  assert.equal(calls[0]!.init.body, undefined)
  assert.equal(calls[0]!.url.searchParams.get("sendUpdates"), "none")
  assert.equal((calendar.actions as Record<string, { effect: string }>)["events.delete"]!.effect, "destructive")
})
