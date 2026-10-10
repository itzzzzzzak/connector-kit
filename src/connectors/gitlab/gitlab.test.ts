import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import gitlab from "./index.js"

const user = { id: 1, username: "ada", name: "Ada L", web_url: "https://gitlab.com/ada" }
const project = { id: 42, name: "Api", path_with_namespace: "acme/api", description: null, web_url: "https://gitlab.com/acme/api", default_branch: "main", visibility: "private", archived: false, star_count: 3, forks_count: 1, open_issues_count: 5, namespace: { id: 7, name: "acme", full_path: "acme" } }
const issue = { id: 900, iid: 12, project_id: 42, title: "Crash on start", description: "steps...", state: "opened", labels: ["bug"], web_url: "https://gitlab.com/acme/api/-/issues/12", created_at: "2026-01-01T00:00:00Z", closed_at: null, due_date: null, author: user, assignees: [] }
const mr = { id: 901, iid: 4, title: "Fix crash", state: "opened", draft: false, has_conflicts: false, detailed_merge_status: "mergeable", source_branch: "fix", target_branch: "main", merged_at: null, web_url: "https://gitlab.com/acme/api/-/merge_requests/4", author: user }
const pipeline = { id: 31, iid: 3, project_id: 42, status: "success", source: "push", ref: "main", sha: "abc", web_url: "https://gitlab.com/acme/api/-/pipelines/31" }
const next = (url: string) => ({ link: `<${url}>; rel="next"` })

standardTests(gitlab, { action: "user.get", input: {}, ok: user })
standardTests(gitlab, { action: "projects.list", input: {}, ok: [project], badInput: { membership: "yes" } })
standardTests(gitlab, { action: "projects.get", input: { id: "acme/api" }, ok: project, badInput: { id: 42 } })
standardTests(gitlab, { action: "issues.list", input: { id: "42" }, ok: [issue], badInput: { id: 42 } })
standardTests(gitlab, { action: "issues.get", input: { id: "42", issue_iid: 12 }, ok: issue, badInput: { id: "42", issue_iid: "x" } })
standardTests(gitlab, { action: "issues.create", input: { id: "42", title: "Crash" }, ok: issue, badInput: { id: "42", title: 5 } })
standardTests(gitlab, { action: "mergeRequests.list", input: { id: "42" }, ok: [mr], badInput: { id: 42 } })
standardTests(gitlab, { action: "pipelines.list", input: { id: "42" }, ok: [pipeline], badInput: { id: 42 } })

test("the token is sent in GitLab's PRIVATE-TOKEN header, not as a Bearer token", async () => {
  const { conn, calls } = harness(gitlab, () => json(user), { credentials: { token: "glpat-abc" } })
  await conn.execute("user.get", {})
  assert.equal(calls[0]!.header("private-token"), "glpat-abc")
  assert.equal(calls[0]!.header("authorization"), null)
  assert.equal(calls[0]!.url.toString(), "https://gitlab.com/api/v4/user")
})

test("a project given by path is URL-encoded as group%2Fproject, as GitLab requires", async () => {
  const { conn, calls } = harness(gitlab, () => json(project))
  await conn.execute("projects.get", { id: "acme/api" })
  assert.equal(calls[0]!.url.pathname, "/api/v4/projects/acme%2Fapi")
  await conn.execute("projects.get", { id: "42" })
  assert.equal(calls[1]!.url.pathname, "/api/v4/projects/42")
})

test("a path that tries to climb out of the project ('..') is rejected before anything is sent", async () => {
  const { conn, calls } = harness(gitlab, () => json(project))
  await assert.rejects(() => conn.execute("projects.get", { id: ".." }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("lists use per_page, follow the Link header, keep the filters, and the token follows the link", async () => {
  const { kit, conn, calls } = harness(gitlab, (c) =>
    c.url.searchParams.get("page") === "2" ? json([{ ...issue, iid: 13 }]) : json([issue], 200, next("https://gitlab.com/api/v4/projects/42/issues?state=opened&page=2&per_page=30")),
  )
  const iids: number[] = []
  for await (const i of kit.paginate(conn, "issues.list", { id: "42", state: "opened", labels: "bug" })) iids.push(i.iid)
  assert.deepEqual(iids, [12, 13])
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "30")
  assert.equal(calls[0]!.url.searchParams.get("labels"), "bug")
  assert.equal(calls[1]!.header("private-token"), "test-token")
})

test("page size is capped at GitLab's 100", async () => {
  const { conn, calls } = harness(gitlab, () => json([]))
  await conn.execute("pipelines.list", { id: "42", pageSize: 5000 })
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "100")
})

test("null descriptions and dates (GitLab sends null for empty fields) are accepted", async () => {
  const { conn } = harness(gitlab, () => json({ ...issue, description: null, closed_at: null, due_date: null }))
  const result = await conn.execute("issues.get", { id: "42", issue_iid: 12 })
  assert.equal(result.description, null)
})

test("issues.create sends the fields as the JSON body, with the project only in the path, and is never retried", async () => {
  const { conn, calls } = harness(gitlab, () => json(issue, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("issues.create", { id: "acme/api", title: "Crash on start", labels: "bug,urgent", confidential: true })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/api/v4/projects/acme%2Fapi/issues")
  assert.deepEqual(calls[0]!.body, { title: "Crash on start", labels: "bug,urgent", confidential: true })
})

test("a title that is empty or over GitLab's 255 characters is rejected locally", async () => {
  const { conn, calls } = harness(gitlab, () => json(issue, 201))
  for (const title of ["", "x".repeat(256)]) await assert.rejects(() => conn.execute("issues.create", { id: "42", title }))
  assert.equal(calls.length, 0)
})
