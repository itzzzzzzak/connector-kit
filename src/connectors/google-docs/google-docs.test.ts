import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import docs from "./index.js"

const doc = { documentId: "d1", title: "Notes", body: { content: [] } }

standardTests(docs, { action: "documents.appendText", input: { documentId: "d1", text: "Hello" }, ok: { documentId: "d1", replies: [{}] }, badInput: { documentId: "d1", text: "" } })
standardTests(docs, { action: "documents.batchUpdate", input: { documentId: "d1", requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }] }, ok: { documentId: "d1", replies: [{}] }, badInput: { documentId: "d1", requests: [] } })
standardTests(docs, { action: "documents.get", input: { documentId: "d1" }, ok: doc, badInput: { documentId: "d1", includeTabsContent: "yes" } })
standardTests(docs, { action: "documents.create", input: { title: "Notes" }, ok: doc })

test("appending text is one insertText request at the end of the body", async () => {
  const { conn, calls } = harness(docs, () => json({ documentId: "d1" }))
  await conn.execute("documents.appendText", { documentId: "d1", text: "Line 1\nLine 2" })
  assert.equal(calls[0]!.url.toString(), "https://docs.googleapis.com/v1/documents/d1:batchUpdate")
  assert.deepEqual(calls[0]!.body, { requests: [{ insertText: { text: "Line 1\nLine 2", endOfSegmentLocation: {} } }] })
})
