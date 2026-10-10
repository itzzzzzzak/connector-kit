// Opt-in smoke test against the REAL Intercom API. Skipped unless INTERCOM_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   INTERCOM_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import intercom from "./index.js"

const token = process.env.INTERCOM_TOKEN
const skip = token ? false : "set INTERCOM_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(intercom, { connectionId: "live", credentials: { token: token! } })

test("live: me, contacts and conversations match our schemas (US region workspace)", { skip }, async () => {
  const me = await conn().execute("me.get", {})
  assert.ok(me.id)
  const contacts = await conn().execute("contacts.list", { pageSize: 3 })
  assert.ok(contacts.items.length <= 3)
  if (contacts.items[0]) await conn().execute("contacts.get", { contact_id: contacts.items[0].id })
  const conversations = await conn().execute("conversations.list", { pageSize: 3 })
  assert.ok(conversations.items.length <= 3)
  if (conversations.items[0]) await conn().execute("conversations.get", { conversation_id: conversations.items[0].id })
})
