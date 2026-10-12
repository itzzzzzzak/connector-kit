import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import onedrive from "./index.js"

const file = { id: "01ABC", name: "plan.docx", size: 1024, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, webUrl: "https://contoso-my.sharepoint.com/x" }
const folder = { id: "01DEF", name: "Docs", folder: { childCount: 2 } }

standardTests(onedrive, { action: "drive.get", input: {}, ok: { id: "b!abc", driveType: "business", quota: { total: 100, used: 10, remaining: 90 } } })
standardTests(onedrive, { action: "children.list", input: {}, ok: { value: [file, folder] }, badInput: { pageSize: 1000 } })
standardTests(onedrive, { action: "item.get", input: { itemId: "01ABC" }, ok: file, badInput: { itemId: "" } })
standardTests(onedrive, { action: "items.search", input: { query: "budget" }, ok: { value: [file] }, badInput: { query: "it's" } })
standardTests(onedrive, { action: "folder.create", input: { name: "Reports" }, ok: folder, badInput: { name: "a/b" } })
standardTests(onedrive, { action: "item.rename", input: { itemId: "01ABC", name: "new.docx" }, ok: file, badInput: { itemId: "01ABC", name: "" } })
standardTests(onedrive, { action: "item.createLink", input: { itemId: "01ABC", type: "view" }, ok: { link: { webUrl: "https://1drv.ms/x", type: "view", scope: "organization" } }, badInput: { itemId: "01ABC", type: "own" } })
standardTests(onedrive, { action: "item.delete", input: { itemId: "01ABC" }, ok: {}, badInput: { itemId: "" } })

test("listing defaults to the root folder and selects a small set of fields", async () => {
  const { conn, calls } = harness(onedrive, () => json({ value: [] }))
  await conn.execute("children.list", { pageSize: 20 })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/drive/items/root/children")
  assert.equal(calls[0]!.url.searchParams.get("$top"), "20")
  assert.ok(calls[0]!.url.searchParams.get("$select")!.includes("lastModifiedDateTime"))
})

test("search puts the query inside the path function, encoded, and cannot break out of its quotes", async () => {
  const { conn, calls } = harness(onedrive, () => json({ value: [] }))
  await conn.execute("items.search", { query: "annual report/2026" })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/drive/root/search(q='annual%20report%2F2026')")
  await assert.rejects(() => conn.execute("items.search", { query: "x')/children?$top=1&a=('" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 1)
})

test("creating a folder refuses to overwrite and sends the folder facet", async () => {
  const { conn, calls } = harness(onedrive, () => json(folder, 201))
  await conn.execute("folder.create", { parentId: "01DEF", name: "Reports" })
  assert.equal(calls[0]!.url.pathname, "/v1.0/me/drive/items/01DEF/children")
  assert.deepEqual(calls[0]!.body, { name: "Reports", folder: {}, "@microsoft.graph.conflictBehavior": "fail" })
})

test("sharing defaults to the organization, and delete is destructive", async () => {
  const { conn, calls } = harness(onedrive, () => json({ link: { webUrl: "https://1drv.ms/x" } }))
  await conn.execute("item.createLink", { itemId: "01ABC", type: "edit" })
  assert.deepEqual(calls[0]!.body, { type: "edit", scope: "organization" })
  assert.equal(onedrive.actions["item.delete"].effect, "destructive")
  assert.equal(onedrive.actions["item.createLink"].effect, "write")
})
