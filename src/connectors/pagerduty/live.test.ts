// Opt-in smoke test against the REAL PagerDuty API. Skipped unless PAGERDUTY_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   PAGERDUTY_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import pagerduty from "./index.js"

const credentials = process.env.PAGERDUTY_TOKEN
const skip = credentials ? false : "set PAGERDUTY_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(pagerduty, { connectionId: "live", credentials: { token: credentials! } })

test("live: incidents, services and on-calls match our schemas", { skip }, async () => {
  const incidents = await conn().execute("incidents.list", { pageSize: 3 })
  assert.ok(incidents.items.length <= 3)
  await conn().execute("services.list", { pageSize: 3 })
  await conn().execute("oncalls.list", { pageSize: 3 })
})
