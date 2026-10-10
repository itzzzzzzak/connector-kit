// Opt-in smoke test against the REAL Slack API. Skipped unless SLACK_BOT_TOKEN is set. Needs a bot token
// with the channels:read scope. Run:  SLACK_BOT_TOKEN=xoxb-... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import { slack } from "./index.js"

const token = process.env.SLACK_BOT_TOKEN
const skip = token ? false : "set SLACK_BOT_TOKEN to run live tests"

test("live: conversations.list returns a bounded page that matches our schema", { skip }, async () => {
  const conn = createConnectorKit().connect(slack, { connectionId: "live", credentials: { token: token! } })
  const page = await conn.execute("conversations.list", { pageSize: 3 })
  assert.ok(page.items.length <= 3)
  for (const channel of page.items) assert.ok(channel.id.length > 0)
})

test("live: an unknown channel is reported as not_found (Slack answers HTTP 200)", { skip }, async () => {
  const conn = createConnectorKit().connect(slack, { connectionId: "live", credentials: { token: token! } })
  await assert.rejects(() => conn.execute("conversations.history", { channel: "C000000000" }), (e: unknown) => ["not_found", "forbidden"].includes((e as { code?: string }).code ?? ""))
})
