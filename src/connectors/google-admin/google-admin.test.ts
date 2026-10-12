import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import admin from "./index.js"

const user = { id: "1", primaryEmail: "ada@acme.dev", name: { fullName: "Ada Lovelace" }, suspended: false, isAdmin: true }
const group = { id: "g1", email: "eng@acme.dev", name: "Engineering", directMembersCount: "12" }

standardTests(admin, { action: "users.list", input: {}, ok: { users: [user], nextPageToken: "p2" }, badInput: { orderBy: "shoeSize" } })
standardTests(admin, { action: "users.get", input: { userKey: "ada@acme.dev" }, ok: user, badInput: { userKey: "" } })
standardTests(admin, { action: "groups.list", input: {}, ok: { groups: [group] }, badInput: { pageSize: "x" } })
standardTests(admin, { action: "members.list", input: { groupKey: "eng@acme.dev" }, ok: { members: [{ id: "1", email: "ada@acme.dev", role: "OWNER", type: "USER" }] }, badInput: { groupKey: "" } })

test("a user list is for the admin's own customer by default and pages with maxResults", async () => {
  const { conn, calls } = harness(admin, () => json({ users: [user] }))
  await conn.execute("users.list", { query: "isSuspended=true", pageSize: 40 })
  assert.equal(calls[0]!.url.pathname, "/admin/directory/v1/users")
  assert.equal(calls[0]!.url.searchParams.get("customer"), "my_customer")
  assert.equal(calls[0]!.url.searchParams.get("maxResults"), "40")
  assert.equal(calls[0]!.url.searchParams.get("query"), "isSuspended=true")
})

test("a user key that is an email address is encoded into the path", async () => {
  const { conn, calls } = harness(admin, () => json(user))
  await conn.execute("users.get", { userKey: "ada@acme.dev" })
  assert.equal(calls[0]!.url.pathname, "/admin/directory/v1/users/ada%40acme.dev")
})

test("the destructive admin calls are marked destructive", () => {
  const actions = admin.actions as Record<string, { effect: string; method: string }>
  for (const [name, action] of Object.entries(actions)) if (action.method === "DELETE") assert.equal(action.effect, "destructive", name)
  assert.ok(Object.keys(actions).length > 100)
})
