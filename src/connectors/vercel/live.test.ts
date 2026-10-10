// Opt-in smoke test against the REAL Vercel API. Skipped unless VERCEL_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   VERCEL_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import vercel from "./index.js"

const token = process.env.VERCEL_TOKEN
const skip = token ? false : "set VERCEL_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(vercel, { connectionId: "live", credentials: { token: token! } })

test("live: user, teams, projects and deployments match our schemas", { skip }, async () => {
  const me = await conn().execute("user.get", {})
  assert.ok(me.user.id)
  await conn().execute("teams.list", { pageSize: 3 })
  const projects = await conn().execute("projects.list", { pageSize: 3 })
  assert.ok(projects.items.length <= 3)
  if (projects.items[0]) await conn().execute("projects.get", { idOrName: projects.items[0].id })
  const deployments = await conn().execute("deployments.list", { pageSize: 3 })
  assert.ok(deployments.items.length <= 3)
  if (deployments.items[0]) await conn().execute("deployments.get", { idOrUrl: deployments.items[0].uid })
})
