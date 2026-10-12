import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import slides from "./index.js"

const deck = { presentationId: "p1", title: "Q4 review", slides: [] }

standardTests(slides, { action: "presentations.get", input: { presentationId: "p1" }, ok: deck, badInput: { presentationId: "p1", fields: 7 } })
standardTests(slides, { action: "presentations.create", input: { title: "Q4 review" }, ok: deck })
standardTests(slides, { action: "presentations.batchUpdate", input: { presentationId: "p1", requests: [{ createSlide: {} }] }, ok: { presentationId: "p1", replies: [{}] }, badInput: { presentationId: "p1", requests: "x" } })

test("a batch update keeps the :batchUpdate suffix and sends the requests in the body", async () => {
  const { conn, calls } = harness(slides, () => json({ presentationId: "p1" }))
  await conn.execute("presentations.batchUpdate", { presentationId: "p1", requests: [{ createSlide: {} }] })
  assert.equal(calls[0]!.url.toString(), "https://slides.googleapis.com/v1/presentations/p1:batchUpdate")
  assert.deepEqual(calls[0]!.body, { requests: [{ createSlide: {} }] })
})
