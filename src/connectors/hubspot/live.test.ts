// Opt-in smoke test against the REAL HubSpot API. Skipped unless HUBSPOT_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   HUBSPOT_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import hubspot from "./index.js"

const token = process.env.HUBSPOT_TOKEN
const skip = token ? false : "set HUBSPOT_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(hubspot, { connectionId: "live", credentials: { token: token! } })

test("live: contacts, companies and deals lists match our schemas (needs the three *.read scopes)", { skip }, async () => {
  for (const action of ["contacts.list", "companies.list", "deals.list"] as const) {
    const page = await conn().execute(action, { pageSize: 3 })
    assert.ok(page.items.length <= 3, action)
    for (const item of page.items) assert.ok(item.id.length > 0, action)
  }
})
