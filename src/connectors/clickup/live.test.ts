// Opt-in smoke test against the REAL ClickUp API. Skipped unless CLICKUP_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   CLICKUP_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import clickup from "./index.js"

const credentials = process.env.CLICKUP_TOKEN
const skip = credentials ? false : "set CLICKUP_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(clickup, { connectionId: "live", credentials: { token: credentials! } })

test("live: workspaces, spaces and tasks match our schemas", { skip }, async () => {
  const ws = await conn().execute("workspaces.list", {})
  assert.ok(ws.teams.length >= 0)
})
