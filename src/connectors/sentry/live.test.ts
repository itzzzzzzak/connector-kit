// Opt-in smoke test against the REAL Sentry API. Skipped unless SENTRY_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) lets the connector move to "live-tested".
//   SENTRY_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import sentry from "./index.js"

const credentials = process.env.SENTRY_TOKEN
const region = process.env.SENTRY_REGION
const skip = credentials && region ? false : "set SENTRY_TOKEN and SENTRY_REGION (us or de) to run live tests"
const conn = () => createConnectorKit().connect(sentry, { connectionId: "live", credentials: { token: credentials! }, variables: { region: region! } })

test("live: organizations, projects and issues match our schemas", { skip }, async () => {
  const orgs = await conn().execute("organizations.list", { pageSize: 3 })
  const org = orgs.items[0]
  if (!org) return
  await conn().execute("projects.list", { organization: org.slug, pageSize: 3 })
  const issues = await conn().execute("issues.list", { organization: org.slug, pageSize: 3 })
  assert.ok(issues.items.length <= 3)
  const first = issues.items[0]
  if (first) await conn().execute("issues.get", { organization: org.slug, issue_id: first.id })
})
