import assert from "node:assert/strict"
import { test } from "node:test"
import { standardTests, harness, json } from "../../connector-harness.test.js"
import asana from "./index.js"

const task = { gid: "1201", name: "Ship it", completed: false, due_on: "2026-11-01", assignee: { gid: "9", name: "Ada" }, projects: [{ gid: "55", name: "Launch" }] }
const list = (data: unknown[], offset?: string) => ({ data, next_page: offset ? { offset, path: "/x", uri: "https://app.asana.com/x" } : null })

// ---- failure paths for every action
standardTests(asana, { action: "users.get", input: { user_gid: "me" }, ok: { data: { gid: "9", name: "Ada" } }, badInput: { user_gid: 5 } })
standardTests(asana, { action: "workspaces.list", input: {}, ok: list([{ gid: "1", name: "Acme" }]), badInput: { pageSize: "ten" } })
standardTests(asana, { action: "projects.list", input: { workspace: "1" }, ok: list([{ gid: "55", name: "Launch" }]), badInput: { workspace: 5 } })
standardTests(asana, { action: "projects.get", input: { project_gid: "55" }, ok: { data: { gid: "55", name: "Launch" } }, badInput: { project_gid: 5 } })
standardTests(asana, { action: "projects.tasks.list", input: { project_gid: "55" }, ok: list([task]), badInput: { project_gid: 5 } })
standardTests(asana, { action: "tasks.get", input: { task_gid: "1201" }, ok: { data: task }, badInput: { task_gid: 5 } })
standardTests(asana, { action: "tasks.create", input: { name: "x", workspace: "1" }, ok: { data: task }, badInput: { name: 5 } })
standardTests(asana, { action: "tasks.update", input: { task_gid: "1201", completed: true }, ok: { data: task }, badInput: { task_gid: 5 } })

// ---- what is specific to Asana
test("users.get 'me' calls /users/me and asks for useful fields (Asana returns only ids by default)", async () => {
  const { conn, calls } = harness(asana, () => json({ data: { gid: "9", name: "Ada", email: "ada@x.dev", workspaces: [{ gid: "1", name: "Acme" }] } }))
  const result = await conn.execute("users.get", { user_gid: "me" })
  assert.equal(result.data.workspaces?.[0]?.name, "Acme")
  assert.equal(calls[0]!.url.toString(), "https://app.asana.com/api/1.0/users/me?opt_fields=name%2Cemail%2Cworkspaces.name")
  assert.equal(calls[0]!.header("authorization"), "Bearer test-token")
})

test("opt_fields can be overridden and extra requested fields survive", async () => {
  const { conn, calls } = harness(asana, () => json({ data: { ...task, custom_marker: "kept" } }))
  const result = await conn.execute("tasks.get", { task_gid: "1201", opt_fields: "name,custom_marker" })
  assert.equal(calls[0]!.url.searchParams.get("opt_fields"), "name,custom_marker")
  assert.equal((result.data as Record<string, unknown>).custom_marker, "kept")
})

test("lists send limit, follow next_page.offset as offset, and keep the project and fields on every page", async () => {
  const { kit, conn, calls } = harness(asana, (call) =>
    call.url.searchParams.get("offset") === null ? json(list([task, { ...task, gid: "1202" }], "OFF2")) : json(list([{ ...task, gid: "1203" }])),
  )
  const gids: string[] = []
  for await (const t of kit.paginate(conn, "projects.tasks.list", { project_gid: "55" })) gids.push(t.gid)
  assert.deepEqual(gids, ["1201", "1202", "1203"])
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.url.searchParams.get("limit"), "30")
  assert.equal(calls[1]!.url.searchParams.get("offset"), "OFF2")
  assert.ok(calls.every((c) => c.url.pathname === "/api/1.0/projects/55/tasks" && c.url.searchParams.get("opt_fields")!.includes("due_on")))
})

test("the page size is capped at 100", async () => {
  const { conn, calls } = harness(asana, () => json(list([])))
  await conn.execute("workspaces.list", { pageSize: 5000 })
  assert.equal(calls[0]!.url.searchParams.get("limit"), "100")
})

test("tasks.create wraps the fields in { data }, sends nothing as query, and is a write", async () => {
  const { conn, calls } = harness(asana, () => json({ data: task }, 201))
  await conn.execute("tasks.create", { name: "Ship it", projects: ["55"], due_on: "2026-11-01", assignee: "me" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.deepEqual(calls[0]!.body, { data: { name: "Ship it", projects: ["55"], due_on: "2026-11-01", assignee: "me" } })
  assert.equal(calls[0]!.url.search, "")
})

test("tasks.update is a PUT with a { data } envelope, null clears a field, and it IS retried (a PUT is idempotent)", async () => {
  let n = 0
  const { conn, calls } = harness(asana, () => (++n === 1 ? json({}, 503) : json({ data: task })), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("tasks.update", { task_gid: "1201", completed: true, due_on: null, assignee: null })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, "PUT")
  assert.equal(calls[1]!.url.pathname, "/api/1.0/tasks/1201")
  assert.deepEqual(calls[1]!.body, { data: { completed: true, due_on: null, assignee: null } })
})

test("a task name that is empty or absurdly long is rejected locally", async () => {
  const { conn, calls } = harness(asana, () => json({ data: task }))
  for (const name of ["", "x".repeat(1001)]) await assert.rejects(() => conn.execute("tasks.create", { name, workspace: "1" }))
  assert.equal(calls.length, 0)
})

test("OAuth uses Asana's endpoints", () => {
  assert.equal(asana.auth.type, "oauth2")
  if (asana.auth.type === "oauth2") {
    assert.equal(asana.auth.authorizeUrl, "https://app.asana.com/-/oauth_authorize")
    assert.equal(asana.auth.tokenUrl, "https://app.asana.com/-/oauth_token")
  }
})
