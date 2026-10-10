// Opt-in smoke test against the REAL Pipedrive API. Skipped unless PIPEDRIVE_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   PIPEDRIVE_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import pipedrive from "./index.js"

const token = process.env.PIPEDRIVE_TOKEN
const skip = token ? false : "set PIPEDRIVE_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(pipedrive, { connectionId: "live", credentials: { token: token! } })

test("live: deals, people, organizations and pipelines match our schemas", { skip }, async () => {
  for (const action of ["deals.list", "persons.list", "organizations.list", "pipelines.list"] as const) {
    const page = await conn().execute(action, { pageSize: 3 })
    assert.ok(page.items.length <= 3, action)
  }
  const deals = await conn().execute("deals.list", { pageSize: 1 })
  if (deals.items[0]) await conn().execute("deals.get", { id: deals.items[0].id })
})
