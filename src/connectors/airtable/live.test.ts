// Opt-in smoke test against the REAL Airtable API. Skipped unless AIRTABLE_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   AIRTABLE_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import airtable from "./index.js"

const token = process.env.AIRTABLE_TOKEN
const skip = token ? false : "set AIRTABLE_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(airtable, { connectionId: "live", credentials: { token: token! } })

test("live: bases, tables and records match our schemas (needs schema.bases:read and data.records:read)", { skip }, async () => {
  const bases = await conn().execute("bases.list", {})
  assert.ok(bases.items.length > 0, "the token should see at least one base")
  const baseId = bases.items[0]!.id
  const { tables } = await conn().execute("tables.list", { baseId })
  assert.ok(tables.length > 0)
  const page = await conn().execute("records.list", { baseId, tableIdOrName: tables[0]!.id, pageSize: 3 })
  assert.ok(page.items.length <= 3)
})
