// Opt-in smoke test against the REAL DigitalOcean API. Skipped unless DIGITALOCEAN_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   DIGITALOCEAN_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import digitalocean from "./index.js"

const token = process.env.DIGITALOCEAN_TOKEN
const skip = token ? false : "set DIGITALOCEAN_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(digitalocean, { connectionId: "live", credentials: { token: token! } })

test("live: account, droplets, domains and DNS records match our schemas", { skip }, async () => {
  const { account } = await conn().execute("account.get", {})
  assert.ok(account.email.length > 0)
  const droplets = await conn().execute("droplets.list", { pageSize: 3 })
  assert.ok(droplets.items.length <= 3)
  if (droplets.items[0]) await conn().execute("droplets.get", { droplet_id: droplets.items[0].id })
  const domains = await conn().execute("domains.list", { pageSize: 3 })
  if (domains.items[0]) await conn().execute("domains.records.list", { domain_name: domains.items[0].name, pageSize: 3 })
})
