import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import linear from "./index.js"

const ID = "3f1c2a9e-7a52-4a58-9a0c-0e1d6f6c9a11"
const issue = { id: ID, identifier: "ENG-1", title: "Fix login", description: null, priority: 2, url: "https://linear.app/acme/issue/ENG-1", state: { id: ID, name: "Todo", type: "unstarted" }, assignee: { id: ID, name: "Ada" }, team: { id: ID, key: "ENG" }, project: null, labels: { nodes: [] } }
const comment = { id: ID, body: "Looks good", createdAt: "2026-10-01T00:00:00.000Z", user: { id: ID, name: "Ada" } }
const team = { id: ID, key: "ENG", name: "Engineering", description: null, private: false }
const user = { id: ID, name: "Ada", displayName: "ada", email: "ada@acme.dev", active: true, admin: false }
const project = { id: ID, name: "Launch", description: null, state: "started", progress: 0.4, lead: null }
const page = (field: string, nodes: unknown[], next: string | null = null) => ({ data: { [field]: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } })
const one = (field: string, value: unknown) => ({ data: { [field]: value } })

const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; badInput?: Record<string, unknown> }> = [
  { action: "viewer.get", input: {}, ok: one("viewer", user) },
  { action: "organization.get", input: {}, ok: one("organization", { id: ID, name: "Acme", urlKey: "acme" }) },
  { action: "teams.list", input: {}, ok: page("teams", [team]), badInput: { pageSize: "ten" } },
  { action: "team.get", input: { id: ID }, ok: one("team", team), badInput: { id: "" } },
  { action: "users.list", input: {}, ok: page("users", [user]), badInput: { filter: "all" } },
  { action: "user.get", input: { id: ID }, ok: one("user", user), badInput: { id: "" } },
  { action: "issues.list", input: { filter: { team: { key: { eq: "ENG" } } } }, ok: page("issues", [issue]), badInput: { includeArchived: "yes" } },
  { action: "issue.get", input: { id: "ENG-1" }, ok: one("issue", issue), badInput: { id: "" } },
  { action: "searchIssues.list", input: { term: "login" }, ok: page("searchIssues", [issue]), badInput: { term: "" } },
  { action: "issue.create", input: { teamId: ID, title: "New" }, ok: one("issueCreate", { success: true, issue }), badInput: { teamId: ID, title: "" } },
  { action: "issue.update", input: { id: ID, title: "Renamed" }, ok: one("issueUpdate", { success: true, issue }), badInput: { id: ID, priority: 9 } },
  { action: "issue.archive", input: { id: ID }, ok: one("issueArchive", { success: true }), badInput: { id: "" } },
  { action: "issue.delete", input: { id: ID }, ok: one("issueDelete", { success: true }), badInput: { id: "" } },
  { action: "comments.list", input: { id: ID }, ok: { data: { issue: { comments: { nodes: [comment], pageInfo: { hasNextPage: false, endCursor: null } } } } }, badInput: { id: "" } },
  { action: "comment.create", input: { issueId: ID, body: "Hi" }, ok: one("commentCreate", { success: true, comment }), badInput: { issueId: ID, body: "" } },
  { action: "projects.list", input: {}, ok: page("projects", [project]), badInput: { pageSize: "x" } },
  { action: "project.get", input: { id: ID }, ok: one("project", project), badInput: { id: "" } },
  { action: "project.create", input: { name: "Launch", teamIds: [ID] }, ok: one("projectCreate", { success: true, project }), badInput: { name: "Launch", teamIds: [] } },
  { action: "workflowStates.list", input: {}, ok: page("workflowStates", [{ id: ID, name: "Todo", type: "unstarted", position: 0, team: { id: ID } }]), badInput: { pageSize: "x" } },
  { action: "issueLabels.list", input: {}, ok: page("issueLabels", [{ id: ID, name: "Bug", color: "#f00", team: null }]), badInput: { pageSize: "x" } },
  { action: "cycles.list", input: {}, ok: page("cycles", [{ id: ID, number: 3, name: null, progress: 0.5, team: { id: ID } }]), badInput: { pageSize: "x" } },
  { action: "documents.list", input: {}, ok: page("documents", [{ id: ID, title: "Spec", updatedAt: "2026-10-01T00:00:00.000Z" }]), badInput: { pageSize: "x" } },
  { action: "document.get", input: { id: ID }, ok: one("document", { id: ID, title: "Spec", content: "# Spec" }), badInput: { id: "" } },
]
for (const c of cases) standardTests(linear, { action: c.action, input: c.input, ok: c.ok, ...(c.badInput && { badInput: c.badInput }) })

const h = (respond: Parameters<typeof harness>[1], token = "lin_api_secret") => harness(linear, respond, { credentials: { token } })

test("a personal API key is sent as is, an OAuth token as a bearer token", async () => {
  const personal = h(() => json(one("viewer", user)))
  await personal.conn.execute("viewer.get", {})
  assert.equal(personal.calls[0]!.url.toString(), "https://api.linear.app/graphql")
  assert.equal(personal.calls[0]!.header("authorization"), "lin_api_secret")
  const oauth = h(() => json(one("viewer", user)), "abc123")
  await oauth.conn.execute("viewer.get", {})
  assert.equal(oauth.calls[0]!.header("authorization"), "Bearer abc123")
})

test("a list sends its filter as a variable and pages with first and after", async () => {
  const { conn, calls } = h((call) => json((call.body as { variables: { after?: string } }).variables.after ? page("issues", [issue]) : page("issues", [issue], "cur_2")))
  const filter = { assignee: { isMe: { eq: true } } }
  const first = (await conn.execute("issues.list", { filter, pageSize: 10 })) as { nextCursor: string | null }
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { filter, first: 10 })
  assert.match((calls[0]!.body as { query: string }).query, /issues\(first: \$first, after: \$after/)
  assert.equal(first.nextCursor, "cur_2")
  const second = (await conn.execute("issues.list", { filter, cursor: "cur_2" })) as { nextCursor: string | null }
  assert.equal((calls[1]!.body as { variables: { after: string } }).variables.after, "cur_2")
  assert.equal(second.nextCursor, null)
})

test("creating an issue wraps the fields in the input variable", async () => {
  const { conn, calls } = h(() => json(one("issueCreate", { success: true, issue })))
  await conn.execute("issue.create", { teamId: ID, title: "New", priority: 2, labelIds: [ID] })
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { input: { teamId: ID, title: "New", priority: 2, labelIds: [ID] } })
  assert.match((calls[0]!.body as { query: string }).query, /^mutation IssueCreate/)
})

test("updating an issue sends the id apart from the changed fields", async () => {
  const { conn, calls } = h(() => json(one("issueUpdate", { success: true, issue })))
  await conn.execute("issue.update", { id: ID, stateId: ID, assigneeId: null })
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { id: ID, input: { stateId: ID, assigneeId: null } })
})

test("an error inside a 200 response is a normalized error, and a missing issue is not_found", async () => {
  const { conn } = h(() => json({ errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input", userPresentableMessage: "Issue not found" } }], data: null }))
  await assert.rejects(() => conn.execute("issue.get", { id: ID }), (e: unknown) => (e as { code?: string }).code === "not_found")
})

test("rate limiting (HTTP 400, RATELIMITED) is retryable and says when the budget refills", async () => {
  const reset = String(Date.now() + 30_000)
  const { conn } = h(() => json({ errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] }, 400, { "x-ratelimit-requests-reset": reset }))
  await assert.rejects(() => conn.execute("issues.list", {}), (e: unknown) => {
    const err = e as { code?: string; retryable?: boolean; retryAfter?: number }
    return err.code === "rate_limited" && err.retryable === true && err.retryAfter !== undefined && err.retryAfter >= 25 && err.retryAfter <= 30
  })
})

test("deleting is destructive and archiving is not", () => {
  assert.equal(linear.actions["issue.delete"]!.effect, "destructive")
  assert.equal(linear.actions["issue.archive"]!.effect, "write")
})
