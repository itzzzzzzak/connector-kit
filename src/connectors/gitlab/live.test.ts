// Opt-in smoke test against the REAL GitLab API. Skipped unless GITLAB_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   GITLAB_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import gitlab from "./index.js"

const token = process.env.GITLAB_TOKEN
const skip = token ? false : "set GITLAB_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(gitlab, { connectionId: "live", credentials: { token: token! } })

test("live: user, projects, issues, merge requests and pipelines match our schemas", { skip }, async () => {
  const me = await conn().execute("user.get", {})
  assert.ok(me.username.length > 0)
  const projects = await conn().execute("projects.list", { membership: true, pageSize: 3 })
  assert.ok(projects.items.length <= 3)
  const project = projects.items[0]
  if (project) {
    const id = String(project.id)
    assert.equal((await conn().execute("projects.get", { id: project.path_with_namespace })).id, project.id) // by path, URL-encoded for us
    await conn().execute("issues.list", { id, pageSize: 3 })
    await conn().execute("mergeRequests.list", { id, pageSize: 3 })
    await conn().execute("pipelines.list", { id, pageSize: 3 })
  }
})
