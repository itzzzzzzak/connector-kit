import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import { ConnectorKitError } from "../../index.js"
import monday from "./index.js"

const one = (field: string, value: unknown) => ({ data: { [field]: value } })
const board = { id: "1234567890", name: "Roadmap", state: "active", board_kind: "public", workspace: { id: "9", name: "Main" } }
const item = { id: "555", name: "Ship it", state: "active", group: { id: "topics", title: "Todo" }, board: { id: board.id }, column_values: [{ id: "status", type: "status", text: "Working on it", value: '{"index":0}' }] }

standardTests(monday, { action: "me.get", input: {}, ok: one("me", { id: "1", name: "Ada", email: "ada@acme.dev", account: { id: "2", name: "Acme" } }) })
standardTests(monday, { action: "users.list", input: {}, ok: one("users", [{ id: "1", name: "Ada", email: "ada@acme.dev", is_admin: true, enabled: true }]), badInput: { limit: 1000 } })
standardTests(monday, { action: "boards.list", input: {}, ok: one("boards", [board]), badInput: { page: 0 } })
standardTests(monday, { action: "board.get", input: { boardId: board.id }, ok: one("boards", [{ ...board, columns: [{ id: "status", title: "Status", type: "status" }], groups: [{ id: "topics", title: "Todo" }] }]), badInput: { boardId: "roadmap" } })
standardTests(monday, { action: "items.list", input: { boardId: board.id }, ok: one("boards", [{ items_page: { cursor: "MSw5NzI4", items: [item] } }]), badInput: { boardId: "" } })
standardTests(monday, { action: "items.next", input: { cursor: "MSw5NzI4" }, ok: one("next_items_page", { cursor: null, items: [item] }), badInput: { cursor: "" } })
standardTests(monday, { action: "item.get", input: { itemId: "555" }, ok: one("items", [item]), badInput: { itemId: "abc" } })
standardTests(monday, { action: "updates.list", input: { itemId: "555" }, ok: one("items", [{ updates: [{ id: "1", body: "<p>hi</p>", text_body: "hi" }] }]), badInput: { itemId: "" } })
standardTests(monday, { action: "item.create", input: { boardId: board.id, itemName: "New" }, ok: one("create_item", { id: "556", name: "New" }), badInput: { boardId: board.id, itemName: "" } })
standardTests(monday, { action: "item.changeColumns", input: { boardId: board.id, itemId: "555", columnValues: { status: { label: "Done" } } }, ok: one("change_multiple_column_values", { id: "555", name: "Ship it" }), badInput: { boardId: board.id, itemId: "555", columnValues: {} } })
standardTests(monday, { action: "update.create", input: { itemId: "555", body: "On track" }, ok: one("create_update", { id: "9", body: "On track" }), badInput: { itemId: "555", body: "" } })
standardTests(monday, { action: "item.archive", input: { itemId: "555" }, ok: one("archive_item", { id: "555" }), badInput: { itemId: "" } })
standardTests(monday, { action: "item.delete", input: { itemId: "555" }, ok: one("delete_item", { id: "555" }), badInput: { itemId: "" } })

test("the token goes in Authorization without Bearer, with the API-Version header, to /v2", async () => {
  const { conn, calls } = harness(monday, () => json(one("me", { id: "1", name: "Ada" })), { credentials: { token: "eyJ.TOKEN" } })
  await conn.execute("me.get", {})
  assert.equal(calls[0]!.url.pathname, "/v2")
  assert.equal(calls[0]!.header("authorization"), "eyJ.TOKEN")
  assert.match(calls[0]!.header("api-version") ?? "", /^\d{4}-\d{2}$/)
})

test("creating an item sends column values as the JSON string monday.com expects", async () => {
  const { conn, calls } = harness(monday, () => json(one("create_item", { id: "556", name: "New" })))
  await conn.execute("item.create", { boardId: board.id, itemName: "New", groupId: "topics", columnValues: { status: { label: "Done" } } })
  const sent = calls[0]!.body as { query: string; variables: Record<string, unknown> }
  assert.match(sent.query, /create_item/)
  assert.deepEqual(sent.variables, { boardId: board.id, itemName: "New", groupId: "topics", columnValues: '{"status":{"label":"Done"}}' })
})

test("items.list reads the first board's items_page, and a board that does not exist is an error, not data", async () => {
  const ok = harness(monday, () => json(one("boards", [{ items_page: { cursor: "c1", items: [item] } }])))
  const page = (await ok.conn.execute("items.list", { boardId: board.id, limit: 1 })) as { cursor: string; items: unknown[] }
  assert.equal(page.cursor, "c1")
  assert.deepEqual((ok.calls[0]!.body as { variables: unknown }).variables, { boardId: board.id, limit: 1 })
  const none = harness(monday, () => json(one("boards", [])))
  await assert.rejects(() => none.conn.execute("items.list", { boardId: board.id }), (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error")
})

test("an HTTP 200 with a GraphQL error is mapped: unauthorized, and a spent complexity budget is a retryable rate limit", async () => {
  const bad = harness(monday, () => json({ errors: [{ message: "Not Authenticated", extensions: { code: "UserUnauthorizedException" } }] }))
  await assert.rejects(() => bad.conn.execute("me.get", {}), (e: unknown) => e instanceof ConnectorKitError && e.code === "auth_expired")
  const slow = harness(monday, () => json({ errors: [{ message: "Complexity budget exhausted, query cost 5000001 ...", extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED" } }] }))
  await assert.rejects(() => slow.conn.execute("me.get", {}), (e: unknown) => e instanceof ConnectorKitError && e.code === "rate_limited" && e.retryable)
})

test("deleting and archiving are destructive; creating and posting are writes", () => {
  assert.equal(monday.actions["item.delete"].effect, "destructive")
  assert.equal(monday.actions["item.archive"].effect, "destructive")
  assert.equal(monday.actions["item.create"].effect, "write")
  assert.equal(monday.actions["update.create"].effect, "write")
})
