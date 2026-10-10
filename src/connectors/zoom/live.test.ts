// Opt-in smoke test against the REAL Zoom API. Skipped unless ZOOM_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   ZOOM_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import zoom from "./index.js"

const token = process.env.ZOOM_TOKEN
const skip = token ? false : "set ZOOM_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(zoom, { connectionId: "live", credentials: { token: token! } })

test("live: meetings and recordings lists match our schemas (needs meeting + recording read scopes on the app)", { skip }, async () => {
  const meetings = await conn().execute("meetings.list", { pageSize: 5 })
  assert.ok(meetings.items.length <= 5)
  const first = meetings.items[0]
  if (first) assert.equal((await conn().execute("meetings.get", { meetingId: first.id })).id, first.id)
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const recordings = await conn().execute("recordings.list", { from, to, pageSize: 5 })
  assert.ok(recordings.items.length <= 5)
})
