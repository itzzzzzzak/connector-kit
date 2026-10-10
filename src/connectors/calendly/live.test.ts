// Opt-in smoke test against the REAL Calendly API. Skipped unless CALENDLY_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   CALENDLY_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import calendly from "./index.js"

const token = process.env.CALENDLY_TOKEN
const skip = token ? false : "set CALENDLY_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(calendly, { connectionId: "live", credentials: { token: token! } })

test("live: users.me, then event types and scheduled events for that user", { skip }, async () => {
  const me = await conn().execute("users.me", {})
  assert.ok(me.resource.uri.startsWith("https://api.calendly.com/users/"))
  const types = await conn().execute("eventTypes.list", { user: me.resource.uri, pageSize: 5 })
  assert.ok(types.items.length <= 5)
  const events = await conn().execute("scheduledEvents.list", { user: me.resource.uri, pageSize: 5 })
  assert.ok(events.items.length <= 5)
})
