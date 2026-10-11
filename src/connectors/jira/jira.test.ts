import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json } from "../../connector-harness.test.js"
import jira, { toAdf } from "./index.js"

const V = { variables: { site: "acme" }, credentials: { token: "me@acme.dev:APITOKEN" } }
const h = (respond: Parameters<typeof harness>[1], opts = {}) => harness(jira, respond, { ...V, ...opts })
const issue = { id: "10001", key: "PROJ-1", self: "https://acme.atlassian.net/rest/api/3/issue/10001", fields: { summary: "Crash on start", status: { name: "Open" }, assignee: null, priority: { name: "High" } } }

test("every action: success, 404, 401, 429 with Retry-After, malformed body, and bad input sends nothing", async () => {
  const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; bad?: Record<string, unknown>; empty?: boolean }> = [
    { action: "myself.get", input: {}, ok: { accountId: "a1", displayName: "Ada", emailAddress: "a@acme.dev" } },
    { action: "projects.list", input: {}, ok: { values: [{ id: "1", key: "PROJ", name: "Project" }], isLast: true }, bad: { query: 5 } },
    { action: "issues.search", input: { jql: "project = PROJ" }, ok: { issues: [issue], isLast: true }, bad: { jql: "" } },
    { action: "issues.get", input: { issueIdOrKey: "PROJ-1" }, ok: issue, bad: { issueIdOrKey: "not a key" } },
    { action: "issues.create", input: { project: "PROJ", summary: "s", issueType: "Task" }, ok: { id: "1", key: "PROJ-2" }, bad: { project: "PROJ", summary: "", issueType: "Task" } },
    { action: "comments.create", input: { issueIdOrKey: "PROJ-1", body: "hi" }, ok: { id: "5", created: "2026-10-01" }, bad: { issueIdOrKey: "PROJ-1", body: "" } },
    { action: "transitions.list", input: { issueIdOrKey: "PROJ-1" }, ok: { transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }] }, bad: { issueIdOrKey: "../x" } },
    { action: "issues.transition", input: { issueIdOrKey: "PROJ-1", transitionId: "21" }, ok: null, bad: { issueIdOrKey: "PROJ-1", transitionId: "abc" }, empty: true },
  ]
  for (const c of cases) {
    const ok = h(() => (c.empty ? new Response(null, { status: 204 }) : json(c.ok)))
    await ok.conn.execute(c.action as never, c.input as never)
    for (const [status, code] of [[404, "not_found"], [401, "auth_expired"]] as const) {
      await assert.rejects(() => h(() => json({}, status)).conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string }).code === code, `${c.action} ${status}`)
    }
    await assert.rejects(() => h(() => json({}, 429, { "retry-after": "4" })).conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string; retryAfter?: number }).code === "rate_limited" && (e as { retryAfter?: number }).retryAfter === 4, `${c.action} 429`)
    if (!c.empty) await assert.rejects(() => h(() => new Response("<html>", { status: 200 })).conn.execute(c.action as never, c.input as never), (e: unknown) => (e as { code?: string }).code === "upstream_error", `${c.action} malformed`)
    if (c.bad) {
      const none = h(() => json(c.ok))
      await assert.rejects(() => none.conn.execute(c.action as never, c.bad as never), (e: unknown) => (e as { code?: string }).code === "invalid_input", `${c.action} bad input`)
      assert.equal(none.calls.length, 0, `${c.action} must send nothing`)
    }
  }
})

test("requests go to the site's own host with Basic 'email:api_token'", async () => {
  const { conn, calls } = h(() => json({ accountId: "a1" }))
  await conn.execute("myself.get", {})
  assert.equal(calls[0]!.url.toString(), "https://acme.atlassian.net/rest/api/3/myself")
  assert.equal(calls[0]!.header("authorization"), `Basic ${Buffer.from("me@acme.dev:APITOKEN").toString("base64")}`)
})

test("a hostile site value is refused before any request", () => {
  for (const site of ["evil.com/x", "acme.evil.com", "a@b", "x:443", ""]) assert.throws(() => harness(jira, () => json({}), { ...V, variables: { site } }), /not valid/, site)
})

test("issue search uses the ENHANCED endpoint, sends default fields, and pages by nextPageToken with the JQL kept", async () => {
  const { kit, conn, calls } = h((c) => json(c.url.searchParams.has("nextPageToken") ? { issues: [{ ...issue, key: "PROJ-2", id: "2" }], isLast: true } : { issues: [issue], nextPageToken: "TOKEN2", isLast: false }))
  const keys: string[] = []
  for await (const i of kit.paginate(conn, "issues.search", { jql: "project = PROJ ORDER BY created DESC" })) keys.push(i.key)
  assert.deepEqual(keys, ["PROJ-1", "PROJ-2"])
  assert.equal(calls[0]!.url.pathname, "/rest/api/3/search/jql")
  assert.equal(calls[0]!.url.searchParams.get("fields"), "summary,status,assignee,priority,issuetype,created,updated,labels")
  assert.equal(calls[0]!.url.searchParams.get("maxResults"), "30")
  assert.equal(calls[1]!.url.searchParams.get("nextPageToken"), "TOKEN2")
  assert.ok(calls.every((c) => c.url.searchParams.get("jql") === "project = PROJ ORDER BY created DESC"))
})

test("the page size is capped at 100", async () => {
  const { conn, calls } = h(() => json({ issues: [] }))
  await conn.execute("issues.search", { jql: "project = PROJ", pageSize: 5000 })
  assert.equal(calls[0]!.url.searchParams.get("maxResults"), "100")
})

test("projects.list follows nextPage and stops when it is absent", async () => {
  const { conn, calls } = h((c) => json(c.url.searchParams.get("startAt") === "50" ? { values: [{ id: "2", key: "B" }], isLast: true } : { values: [{ id: "1", key: "A" }], isLast: false, nextPage: "https://acme.atlassian.net/rest/api/3/project/search?startAt=50&maxResults=30" }))
  const first = await conn.execute("projects.list", { query: "x" })
  assert.equal(first.nextCursor, "https://acme.atlassian.net/rest/api/3/project/search?startAt=50&maxResults=30")
  const second = await conn.execute("projects.list", { query: "x", cursor: first.nextCursor! })
  assert.equal(second.nextCursor, null)
  assert.equal(calls[1]!.url.searchParams.get("startAt"), "50")
})

test("issues.get accepts a key or a numeric id and rejects anything that could change the path", async () => {
  const { conn, calls } = h(() => json(issue))
  await conn.execute("issues.get", { issueIdOrKey: "PROJ-1" })
  await conn.execute("issues.get", { issueIdOrKey: "10001" })
  assert.equal(calls[0]!.url.pathname, "/rest/api/3/issue/PROJ-1")
  for (const bad of ["..", "PROJ-1/../../x", "PROJ-1?x=1", "PROJ-1 ", "-1", "a/b"]) await assert.rejects(() => conn.execute("issues.get", { issueIdOrKey: bad }), (e: unknown) => (e as { code?: string }).code === "invalid_input", bad)
  assert.equal(calls.length, 2)
})

test("plain text becomes Atlassian Document Format: blank lines separate paragraphs, empty input yields no paragraphs", () => {
  assert.deepEqual(toAdf("first\n\nsecond line one\nsecond line two"), {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      { type: "paragraph", content: [{ type: "text", text: "second line one\nsecond line two" }] },
    ],
  })
  assert.deepEqual(toAdf("  \n\n  ").content, [])
})

test("issues.create builds Jira's nested fields with an ADF description, and is never retried", async () => {
  const { conn, calls } = h(() => json({ id: "1", key: "PROJ-9", self: "x" }, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("issues.create", { project: "PROJ", summary: "Crash", issueType: "Bug", description: "Steps\n\nExpected", priority: "High", labels: ["urgent"], assigneeAccountId: "a1" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/rest/api/3/issue")
  const body = calls[0]!.body as { fields: Record<string, unknown> }
  assert.deepEqual(body.fields.project, { key: "PROJ" })
  assert.deepEqual(body.fields.issuetype, { name: "Bug" })
  assert.deepEqual(body.fields.priority, { name: "High" })
  assert.deepEqual(body.fields.assignee, { accountId: "a1" })
  assert.equal((body.fields.description as { type: string }).type, "doc")
})

test("a label with a space is rejected locally (Jira would reject it)", async () => {
  const { conn, calls } = h(() => json({ id: "1", key: "P-1" }, 201))
  await assert.rejects(() => conn.execute("issues.create", { project: "PROJ", summary: "s", issueType: "Task", labels: ["two words"] }))
  assert.equal(calls.length, 0)
})

test("comments.create sends an ADF body and the key only in the path; it is not retried", async () => {
  const { conn, calls } = h(() => json({ id: "5" }, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("comments.create", { issueIdOrKey: "PROJ-1", body: "Looks fixed." })
  assert.equal(calls[0]!.url.pathname, "/rest/api/3/issue/PROJ-1/comment")
  assert.deepEqual(calls[0]!.body, { body: toAdf("Looks fixed.") })
})

test("issues.transition sends { transition: { id } }, accepts the empty 204 answer, and is never retried", async () => {
  const { conn, calls } = h(() => new Response(null, { status: 204 }), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  assert.equal(await conn.execute("issues.transition", { issueIdOrKey: "PROJ-1", transitionId: "31" }), undefined)
  assert.deepEqual(calls[0]!.body, { transition: { id: "31" } })
  const failing = h(() => json({}, 503), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await assert.rejects(() => failing.conn.execute("issues.transition", { issueIdOrKey: "PROJ-1", transitionId: "31" }))
  assert.equal(failing.calls.length, 1)
})

test("the credential never appears in an error", async () => {
  const { conn } = h(() => json({ errorMessages: ["bad"] }, 401))
  await assert.rejects(() => conn.execute("myself.get", {}), (e: unknown) => !JSON.stringify(e).includes("APITOKEN") && !(e as Error).message.includes("APITOKEN") && !JSON.stringify(e).includes(Buffer.from("me@acme.dev:APITOKEN").toString("base64")))
})
