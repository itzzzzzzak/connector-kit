import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import clickup from "./index.js"

const task = { id: "86a1", name: "Ship it", text_content: "details", status: { status: "in progress", type: "custom", color: "#fff" }, priority: { id: "2", priority: "high" }, date_created: "1700000000000", due_date: null, assignees: [{ id: 183, username: "ada", email: "a@x.dev" }], tags: [{ name: "launch" }], url: "https://app.clickup.com/t/86a1", list: { id: "901", name: "Sprint" } }
const tasks = (items: unknown[], last: boolean) => ({ tasks: items, last_page: last })

standardTests(clickup, { action: "workspaces.list", input: {}, ok: { teams: [{ id: "9001", name: "Acme" }] } })
standardTests(clickup, { action: "spaces.list", input: { team_id: "9001" }, ok: { spaces: [{ id: "s1", name: "Eng", private: false }] }, badInput: { team_id: 5 } })
standardTests(clickup, { action: "folders.list", input: { space_id: "s1" }, ok: { folders: [{ id: "f1", name: "Q4", task_count: "5" }] }, badInput: { space_id: 5 } })
standardTests(clickup, { action: "lists.list", input: { folder_id: "f1" }, ok: { lists: [{ id: "901", name: "Sprint", task_count: 3 }] }, badInput: { folder_id: 5 } })
standardTests(clickup, { action: "lists.folderless.list", input: { space_id: "s1" }, ok: { lists: [{ id: "902", name: "Inbox" }] }, badInput: { space_id: 5 } })
standardTests(clickup, { action: "tasks.list", input: { list_id: "901" }, ok: tasks([task], true), badInput: { list_id: 5 } })
standardTests(clickup, { action: "tasks.get", input: { task_id: "86a1" }, ok: task, badInput: { task_id: 5 } })
standardTests(clickup, { action: "tasks.create", input: { list_id: "901", name: "x" }, ok: task, badInput: { list_id: "901", name: 5 } })
standardTests(clickup, { action: "tasks.update", input: { task_id: "86a1", status: "done" }, ok: task, badInput: { task_id: 5 } })

test("the key is the RAW Authorization value (no 'Bearer'), against the v2 base", async () => {
  const { conn, calls } = harness(clickup, () => json({ teams: [] }), { credentials: { token: "pk_12345" } })
  await conn.execute("workspaces.list", {})
  assert.equal(calls[0]!.header("authorization"), "pk_12345")
  assert.equal(calls[0]!.url.toString(), "https://api.clickup.com/api/v2/team")
})

test("tasks.list pages by 0-based page numbers until last_page, sending no page-size parameter, and keeps the filters", async () => {
  const { kit, conn, calls } = harness(clickup, (c) => {
    const page = Number(c.url.searchParams.get("page") ?? 0)
    return json(tasks([{ ...task, id: `t${page}` }], page >= 2))
  })
  const ids: string[] = []
  for await (const t of kit.paginate(conn, "tasks.list", { list_id: "901", include_closed: true, statuses: ["open", "in progress"], assignees: [183] })) ids.push(t.id)
  assert.deepEqual(ids, ["t0", "t1", "t2"])
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("page")), [null, "1", "2"])
  assert.ok(calls.every((c) => c.url.searchParams.get("include_closed") === "true"))
  assert.ok(calls.every((c) => c.url.searchParams.getAll("statuses[]").join("|") === "open|in progress" && c.url.searchParams.getAll("assignees[]").join() === "183"))
  assert.ok(calls.every((c) => !c.url.searchParams.has("limit") && !c.url.searchParams.has("page_size")))
})

test("an empty first page ends paging immediately", async () => {
  const { conn } = harness(clickup, () => json(tasks([], false)))
  assert.equal((await conn.execute("tasks.list", { list_id: "901" })).nextCursor, null)
})

test("null priorities and due dates (unset on most tasks) are accepted", async () => {
  const { conn } = harness(clickup, () => json({ ...task, priority: null, due_date: null, date_closed: null, parent: null }))
  const t = await conn.execute("tasks.get", { task_id: "86a1" })
  assert.equal(t.priority, null)
})

test("tasks.create sends the fields as the body with the list only in the path, and is NOT retried", async () => {
  const { conn, calls } = harness(clickup, () => json(task), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("tasks.create", { list_id: "901", name: "Ship it", priority: 2, assignees: [183], due_date: 1_800_000_000_000, tags: ["launch"] })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/api/v2/list/901/task")
  assert.deepEqual(calls[0]!.body, { name: "Ship it", priority: 2, assignees: [183], due_date: 1_800_000_000_000, tags: ["launch"] })
})

test("priority must be 1-4 (anything else is rejected before sending)", async () => {
  const { conn, calls } = harness(clickup, () => json(task))
  for (const priority of [0, 5, 2.5, "high"]) await assert.rejects(() => conn.execute("tasks.create", { list_id: "901", name: "x", priority: priority as never }))
  assert.equal(calls.length, 0)
})

test("tasks.update is a PUT that can clear priority and due date with null, and IS retried", async () => {
  let n = 0
  const { conn, calls } = harness(clickup, () => (++n === 1 ? json({}, 503) : json(task)), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("tasks.update", { task_id: "86a1", status: "done", priority: null, due_date: null })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, "PUT")
  assert.equal(calls[1]!.url.pathname, "/api/v2/task/86a1")
  assert.deepEqual(calls[1]!.body, { status: "done", priority: null, due_date: null })
})
