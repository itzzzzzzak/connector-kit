// Opt-in smoke test against the REAL Jira Cloud API. Skipped unless JIRA_CREDENTIALS and JIRA_SITE are set.
// Read-only actions only. Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   JIRA_SITE=acme JIRA_CREDENTIALS='you@co.com:API_TOKEN' pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import jira from "./index.js"

const credentials = process.env.JIRA_CREDENTIALS
const site = process.env.JIRA_SITE
const skip = credentials && site ? false : "set JIRA_CREDENTIALS and JIRA_SITE to run live tests"
const conn = () => createConnectorKit().connect(jira, { connectionId: "live", credentials: { token: credentials! }, variables: { site: site! } })

test("live: myself, projects, JQL search (enhanced endpoint), an issue and its transitions match our schemas", { skip }, async () => {
  const me = await conn().execute("myself.get", {})
  assert.ok(me.accountId)
  const projects = await conn().execute("projects.list", { pageSize: 3 })
  assert.ok(projects.items.length <= 3)
  const key = projects.items[0]?.key
  if (!key) return
  const found = await conn().execute("issues.search", { jql: `project = ${key} ORDER BY created DESC`, pageSize: 3 })
  assert.ok(found.items.length <= 3)
  const first = found.items[0]
  if (first) {
    assert.equal((await conn().execute("issues.get", { issueIdOrKey: first.key })).key, first.key)
    await conn().execute("transitions.list", { issueIdOrKey: first.key })
  }
})
