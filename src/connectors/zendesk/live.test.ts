// Opt-in smoke test against the REAL Zendesk API. Skipped unless ZENDESK_CREDENTIALS and ZENDESK_SUBDOMAIN are set.
// Read-only actions only. Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   ZENDESK_SUBDOMAIN=acme ZENDESK_CREDENTIALS='you@co.com/token:API_TOKEN' pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import zendesk from "./index.js"

const credentials = process.env.ZENDESK_CREDENTIALS
const subdomain = process.env.ZENDESK_SUBDOMAIN
const skip = credentials && subdomain ? false : "set ZENDESK_CREDENTIALS and ZENDESK_SUBDOMAIN to run live tests"
const conn = () => createConnectorKit().connect(zendesk, { connectionId: "live", credentials: { token: credentials! }, variables: { subdomain: subdomain! } })

test("live: current user, tickets (cursor paging), comments and search match our schemas", { skip }, async () => {
  const me = await conn().execute("users.me", {})
  assert.ok(me.user.id)
  const tickets = await conn().execute("tickets.list", { pageSize: 3 })
  assert.ok(tickets.items.length <= 3)
  const first = tickets.items[0]
  if (first) {
    await conn().execute("tickets.get", { ticket_id: first.id })
    await conn().execute("tickets.comments.list", { ticket_id: first.id, pageSize: 3 })
  }
  const found = await conn().execute("search", { query: "type:ticket", pageSize: 3 })
  assert.ok(found.items.length <= 3)
})
