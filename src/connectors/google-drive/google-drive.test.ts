import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import drive from "./index.js"

const file = { id: "f1", name: "Plan", mimeType: "application/pdf", parents: ["root1"], trashed: false, size: "1024", owners: [{ displayName: "Ada", emailAddress: "ada@acme.dev" }] }
const permission = { id: "p1", type: "user", role: "reader", emailAddress: "bob@acme.dev" }

standardTests(drive, { action: "about.get", input: {}, ok: { user: { displayName: "Ada" }, storageQuota: { limit: "100" } } })
standardTests(drive, { action: "files.list", input: { q: "trashed = false" }, ok: { files: [file], nextPageToken: "p2" }, badInput: { corpora: "everywhere" } })
standardTests(drive, { action: "files.get", input: { fileId: "f1" }, ok: file, badInput: { fileId: "" } })
standardTests(drive, { action: "files.create", input: { name: "Docs", mimeType: "application/vnd.google-apps.folder" }, ok: file, badInput: { name: "" } })
standardTests(drive, { action: "files.update", input: { fileId: "f1", name: "Plan v2" }, ok: file, badInput: { fileId: "f1", trashed: "yes" } })
standardTests(drive, { action: "files.delete", input: { fileId: "f1" }, ok: {}, badInput: { fileId: "" } })
standardTests(drive, { action: "permissions.list", input: { fileId: "f1" }, ok: { permissions: [permission] }, badInput: { fileId: "" } })
standardTests(drive, { action: "permissions.create", input: { fileId: "f1", type: "user", role: "reader", emailAddress: "bob@acme.dev" }, ok: permission, badInput: { fileId: "f1", type: "everyone", role: "reader" } })

test("a listing asks for useful fields (Drive returns almost nothing otherwise) and supports shared drives", async () => {
  const { conn, calls } = harness(drive, () => json({ files: [file] }))
  await conn.execute("files.list", { q: "name contains 'plan'", pageSize: 10 })
  const url = calls[0]!.url
  assert.equal(url.pathname, "/drive/v3/files")
  assert.match(url.searchParams.get("fields")!, /^nextPageToken,files\(id,name,mimeType/)
  assert.equal(url.searchParams.get("pageSize"), "10")
  assert.equal(url.searchParams.get("supportsAllDrives"), "true")
  assert.equal(url.searchParams.get("q"), "name contains 'plan'")
  await conn.execute("files.list", { fields: "files(id)" })
  assert.equal(calls[1]!.url.searchParams.get("fields"), "files(id)")
})

test("the next page is requested with pageToken", async () => {
  const { conn, calls } = harness(drive, (call) => json(call.url.searchParams.get("pageToken") ? { files: [] } : { files: [file], nextPageToken: "p2" }))
  const first = (await conn.execute("files.list", {})) as { nextCursor: string | null }
  assert.equal(first.nextCursor, "p2")
  await conn.execute("files.list", { cursor: "p2" })
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "p2")
})

test("moving a file puts the parents in the query and the rest in the body", async () => {
  const { conn, calls } = harness(drive, () => json(file))
  await conn.execute("files.update", { fileId: "f1", trashed: true, addParents: "new1", removeParents: "old1" })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.equal(calls[0]!.url.searchParams.get("addParents"), "new1")
  assert.equal(calls[0]!.url.searchParams.get("removeParents"), "old1")
  assert.deepEqual(calls[0]!.body, { trashed: true })
})

test("sharing sends the grant in the body and the notification choice in the query", async () => {
  const { conn, calls } = harness(drive, () => json(permission))
  await conn.execute("permissions.create", { fileId: "f1", type: "user", role: "writer", emailAddress: "bob@acme.dev", sendNotificationEmail: false })
  assert.equal(calls[0]!.url.pathname, "/drive/v3/files/f1/permissions")
  assert.equal(calls[0]!.url.searchParams.get("sendNotificationEmail"), "false")
  assert.deepEqual(calls[0]!.body, { type: "user", role: "writer", emailAddress: "bob@acme.dev" })
})

test("a permanent delete is destructive, and the export download (not JSON) is left out", () => {
  const actions = drive.actions as Record<string, { effect: string; path: string }>
  assert.equal(actions["files.delete"]!.effect, "destructive")
  assert.equal(Object.values(actions).some((a) => a.path.endsWith("/export")), false)
})
