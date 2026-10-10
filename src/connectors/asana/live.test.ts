// Opt-in smoke test against the REAL Asana API. Skipped unless ASANA_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   ASANA_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import asana from "./index.js"

const token = process.env.ASANA_TOKEN
const skip = token ? false : "set ASANA_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(asana, { connectionId: "live", credentials: { token: token! } })

test("live: users.get 'me' and workspaces.list match our schemas", { skip }, async () => {
  const me = await conn().execute("users.get", { user_gid: "me" })
  assert.ok(me.data.gid.length > 0)
  const workspaces = await conn().execute("workspaces.list", { pageSize: 5 })
  assert.ok(workspaces.items.length > 0, "the token should see at least one workspace")
  const projects = await conn().execute("projects.list", { workspace: workspaces.items[0]!.gid, pageSize: 3 })
  assert.ok(projects.items.length <= 3)
})
