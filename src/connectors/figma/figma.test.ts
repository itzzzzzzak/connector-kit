import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import figma from "./index.js"

const file = { name: "Design system", role: "owner", lastModified: "2026-10-01T00:00:00Z", editorType: "figma", version: "99", document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS" }] } }
const comment = { id: "c1", file_key: "KEY", user: { id: "u1", handle: "ada" }, created_at: "2026-10-01T00:00:00Z", resolved_at: null, message: "Looks good", order_id: null }

standardTests(figma, { action: "me.get", input: {}, ok: { id: "u1", handle: "ada", email: "a@b.dev" } })
standardTests(figma, { action: "files.get", input: { file_key: "KEY" }, ok: file, badInput: { file_key: 5 } })
standardTests(figma, { action: "files.nodes.get", input: { file_key: "KEY", ids: "1:2" }, ok: { name: "D", nodes: { "1:2": { document: { id: "1:2", type: "FRAME" } } } }, badInput: { file_key: "KEY", ids: 5 } })
standardTests(figma, { action: "images.render", input: { file_key: "KEY", ids: "1:2" }, ok: { err: null, images: { "1:2": "https://s3.example.figma/img.png" } }, badInput: { file_key: "KEY", ids: "1:2", format: "gif" } })
standardTests(figma, { action: "comments.list", input: { file_key: "KEY" }, ok: { comments: [comment] }, badInput: { file_key: 5 } })
standardTests(figma, { action: "comments.create", input: { file_key: "KEY", message: "hi" }, ok: comment, badInput: { file_key: "KEY", message: 5 } })

test("the token goes in X-Figma-Token (not Authorization), and the tree depth defaults to 2", async () => {
  const { conn, calls } = harness(figma, () => json(file), { credentials: { token: "figd_abc" } })
  const result = await conn.execute("files.get", { file_key: "KEY" })
  assert.equal(result.document.children?.length, 1)
  assert.equal(calls[0]!.header("x-figma-token"), "figd_abc")
  assert.equal(calls[0]!.header("authorization"), null)
  assert.equal(calls[0]!.url.pathname, "/v1/files/KEY")
  assert.equal(calls[0]!.url.searchParams.get("depth"), "2")
})

test("the tree depth is bounded (a Figma file can be enormous)", async () => {
  const { conn, calls } = harness(figma, () => json(file))
  for (const depth of [0, 11, 1.5]) await assert.rejects(() => conn.execute("files.get", { file_key: "KEY", depth }))
  assert.equal(calls.length, 0)
  await conn.execute("files.get", { file_key: "KEY", depth: 1 })
  assert.equal(calls[0]!.url.searchParams.get("depth"), "1")
})

test("nodes: ids are sent as given (colons intact); a node that does not exist comes back null", async () => {
  const { conn, calls } = harness(figma, () => json({ name: "D", nodes: { "1:2": { document: { id: "1:2", type: "FRAME" } }, "9:9": null } }))
  const result = await conn.execute("files.nodes.get", { file_key: "KEY", ids: "1:2,9:9" })
  assert.equal(calls[0]!.url.searchParams.get("ids"), "1:2,9:9")
  assert.equal(result.nodes["9:9"], null)
})

test("images.render defaults to png and returns URLs; an unrenderable node is null", async () => {
  const { conn, calls } = harness(figma, () => json({ err: null, images: { "1:2": "https://x/y.png", "3:4": null } }))
  const result = await conn.execute("images.render", { file_key: "KEY", ids: "1:2,3:4", scale: 2 })
  assert.equal(calls[0]!.url.searchParams.get("format"), "png")
  assert.equal(calls[0]!.url.searchParams.get("scale"), "2")
  assert.equal(result.images["3:4"], null)
})

test("comments.create sends only the message (and reply target) as the body, and is never retried", async () => {
  const { conn, calls } = harness(figma, () => json(comment), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("comments.create", { file_key: "KEY", message: "Nice", comment_id: "c0" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/v1/files/KEY/comments")
  assert.deepEqual(calls[0]!.body, { message: "Nice", comment_id: "c0" })
})

test("an empty or huge comment is rejected locally", async () => {
  const { conn, calls } = harness(figma, () => json(comment))
  for (const message of ["", "x".repeat(10_001)]) await assert.rejects(() => conn.execute("comments.create", { file_key: "KEY", message }))
  assert.equal(calls.length, 0)
})

test("the deprecated team-projects and project-files endpoints are deliberately not exposed", () => {
  assert.ok(!Object.values(figma.actions).some((a) => /\/teams\/|\/projects\//.test(a.path)))
})
