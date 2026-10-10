// Opt-in smoke test against the REAL Netlify API. Skipped unless NETLIFY_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   NETLIFY_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import netlify from "./index.js"

const token = process.env.NETLIFY_TOKEN
const skip = token ? false : "set NETLIFY_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(netlify, { connectionId: "live", credentials: { token: token! } })

test("live: user, sites and deploys match our schemas", { skip }, async () => {
  const me = await conn().execute("user.get", {})
  assert.ok(me.id)
  const sites = await conn().execute("sites.list", { pageSize: 3 })
  assert.ok(sites.items.length <= 3)
  const site = sites.items[0]
  if (site) {
    await conn().execute("sites.get", { site_id: site.id })
    const deploys = await conn().execute("sites.deploys.list", { site_id: site.id, pageSize: 3 })
    if (deploys.items[0]) await conn().execute("deploys.get", { deploy_id: deploys.items[0].id })
  }
})
