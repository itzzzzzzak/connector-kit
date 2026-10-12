import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import tasks from "./index.js"

const task = { id: "t1", title: "Write report", status: "needsAction", due: "2026-10-20T00:00:00.000Z" }

standardTests(tasks, { action: "tasklists.list", input: {}, ok: { items: [{ id: "L1", title: "My Tasks" }], nextPageToken: "p2" }, badInput: { pageSize: "ten" } })
standardTests(tasks, { action: "tasks.list", input: {}, ok: { items: [task] }, badInput: { showCompleted: "yes" } })
standardTests(tasks, { action: "tasks.insert", input: { title: "Write report" }, ok: task, badInput: { title: "" } })
standardTests(tasks, { action: "tasks.patch", input: { task: "t1", status: "completed" }, ok: task, badInput: { task: "t1", status: "done" } })
standardTests(tasks, { action: "tasks.delete", input: { task: "t1" }, ok: {}, badInput: { task: "" } })

test("tasks go to the default list, and a subtask names its parent in the query", async () => {
  const { conn, calls } = harness(tasks, () => json(task))
  await conn.execute("tasks.insert", { title: "Sub", parent: "t0", notes: "n" })
  assert.equal(calls[0]!.url.pathname, "/tasks/v1/lists/%40default/tasks")
  assert.equal(calls[0]!.url.searchParams.get("parent"), "t0")
  assert.deepEqual(calls[0]!.body, { title: "Sub", notes: "n" })
})

test("completing a task patches only the status", async () => {
  const { conn, calls } = harness(tasks, () => json(task))
  await conn.execute("tasks.patch", { tasklist: "L1", task: "t1", status: "completed" })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.equal(calls[0]!.url.pathname, "/tasks/v1/lists/L1/tasks/t1")
})
