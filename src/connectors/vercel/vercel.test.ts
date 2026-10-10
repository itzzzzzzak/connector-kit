import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import vercel from "./index.js"

const dep = { uid: "dpl_1", name: "web", url: "web-abc.vercel.app", state: "READY", readyState: "READY", target: "production", projectId: "prj_1", created: 1700000000000, creator: { uid: "u1", username: "ada" }, meta: { githubCommitMessage: "fix crash" } }
const project = { id: "prj_1", name: "web", framework: "nextjs", nodeVersion: "22.x", rootDirectory: null, createdAt: 1690000000000, updatedAt: 1700000000000 }
const list = (key: string, items: unknown[], next: number | null = null) => ({ [key]: items, pagination: { count: items.length, next, prev: null } })

standardTests(vercel, { action: "user.get", input: {}, ok: { user: { id: "u1", email: "a@b.dev", username: "ada" } } })
standardTests(vercel, { action: "teams.list", input: {}, ok: list("teams", [{ id: "team_1", slug: "acme", name: "Acme" }]), badInput: { pageSize: "x" } })
standardTests(vercel, { action: "projects.list", input: {}, ok: list("projects", [project]), badInput: { search: 5 } })
standardTests(vercel, { action: "projects.get", input: { idOrName: "web" }, ok: project, badInput: { idOrName: 5 } })
standardTests(vercel, { action: "deployments.list", input: {}, ok: list("deployments", [dep]), badInput: { target: "staging" } })
standardTests(vercel, { action: "deployments.get", input: { idOrUrl: "dpl_1" }, ok: { id: "dpl_1", name: "web", readyState: "READY", createdAt: 1700000000000 }, badInput: { idOrUrl: 5 } })

test("the numeric pagination.next timestamp is sent back as 'until', and the filters survive every page", async () => {
  const { kit, conn, calls } = harness(vercel, (c) => json(c.url.searchParams.has("until") ? list("deployments", [{ ...dep, uid: "dpl_2" }]) : list("deployments", [dep], 1699999999999)))
  const ids: string[] = []
  for await (const d of kit.paginate(conn, "deployments.list", { projectId: "prj_1", target: "production", teamId: "team_1" })) ids.push(d.uid)
  assert.deepEqual(ids, ["dpl_1", "dpl_2"])
  assert.equal(calls[0]!.url.pathname, "/v7/deployments")
  assert.equal(calls[0]!.url.searchParams.get("limit"), "30")
  assert.equal(calls[1]!.url.searchParams.get("until"), "1699999999999")
  assert.ok(calls.every((c) => c.url.searchParams.get("projectId") === "prj_1" && c.url.searchParams.get("teamId") === "team_1" && c.url.searchParams.get("target") === "production"))
})

test("a null pagination.next is the last page; the page size caps at 100", async () => {
  const { conn, calls } = harness(vercel, () => json(list("projects", [project], null)))
  const page = await conn.execute("projects.list", { pageSize: 9999 })
  assert.equal(page.nextCursor, null)
  assert.equal(calls[0]!.url.searchParams.get("limit"), "100")
  assert.equal(calls[0]!.url.pathname, "/v10/projects")
})

test("teamId is optional and is sent only when given", async () => {
  const { conn, calls } = harness(vercel, () => json(project))
  await conn.execute("projects.get", { idOrName: "web" })
  await conn.execute("projects.get", { idOrName: "web", teamId: "team_9" })
  assert.equal(calls[0]!.url.searchParams.has("teamId"), false)
  assert.equal(calls[1]!.url.searchParams.get("teamId"), "team_9")
  assert.equal(calls[0]!.url.pathname, "/v9/projects/web")
})

test("deployments.get tolerates a failed build: error fields present, URL missing", async () => {
  const { conn } = harness(vercel, () => json({ id: "dpl_x", readyState: "ERROR", errorCode: "BUILD_FAILED", errorMessage: "Command failed", url: null, inspectorUrl: null }))
  const d = await conn.execute("deployments.get", { idOrUrl: "dpl_x" })
  assert.equal(d.readyState, "ERROR")
  assert.equal(d.errorMessage, "Command failed")
})

test("every action is read-only", () => {
  assert.ok(Object.values(vercel.actions).every((a) => a.effect === "read"))
})
