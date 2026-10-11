// Opt-in smoke test against the REAL Mailchimp API. Skipped unless MAILCHIMP_CREDENTIALS is set. Read-only actions only.
// Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   MAILCHIMP_CREDENTIALS=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import mailchimp from "./index.js"

const credentials = process.env.MAILCHIMP_CREDENTIALS
const dc = process.env.MAILCHIMP_DC
const skip = credentials && dc ? false : "set MAILCHIMP_CREDENTIALS and MAILCHIMP_DC (e.g. us19; credentials are anystring:API_KEY) to run live tests"
const conn = () => createConnectorKit().connect(mailchimp, { connectionId: "live", credentials: { token: credentials! }, variables: { dc: dc! } })

test("live: ping, audiences (count/offset paging) and campaigns match our schemas", { skip }, async () => {
  assert.ok((await conn().execute("ping.get", {})).health_status)
  const lists = await conn().execute("lists.list", { pageSize: 3 })
  assert.ok(lists.items.length <= 3)
  const first = lists.items[0]
  if (first) await conn().execute("members.list", { list_id: first.id, pageSize: 3 })
  await conn().execute("campaigns.list", { pageSize: 3 })
})
