import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import classroom from "./index.js"

const course = { id: "c1", name: "Physics 101", courseState: "ACTIVE" }

standardTests(classroom, { action: "courses.list", input: {}, ok: { courses: [course], nextPageToken: "p2" }, badInput: { courseStates: ["MAYBE"] } })
standardTests(classroom, { action: "courses.get", input: { id: "c1" }, ok: course, badInput: { id: 5 } })
standardTests(classroom, { action: "courses.delete", input: { id: "c1" }, ok: {}, badInput: { id: 5 } })

test("a course list filters by state and pages with pageToken", async () => {
  const { conn, calls } = harness(classroom, () => json({ courses: [course], nextPageToken: "p2" }))
  const page = (await conn.execute("courses.list", { courseStates: ["ACTIVE", "ARCHIVED"], teacherId: "me", pageSize: 10 })) as { nextCursor: string | null }
  assert.deepEqual(calls[0]!.url.searchParams.getAll("courseStates"), ["ACTIVE", "ARCHIVED"])
  assert.equal(calls[0]!.url.searchParams.get("teacherId"), "me")
  assert.equal(calls[0]!.url.searchParams.get("pageSize"), "10")
  assert.equal(page.nextCursor, "p2")
})

test("deleting a course is destructive", () => {
  assert.equal((classroom.actions as Record<string, { effect: string }>)["courses.delete"]!.effect, "destructive")
})
