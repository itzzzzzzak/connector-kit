import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import forms from "./index.js"

const form = { formId: "f1", info: { title: "Survey" }, items: [] }

standardTests(forms, { action: "forms.get", input: { formId: "f1" }, ok: form, badInput: { formId: 3 } })
standardTests(forms, { action: "forms.create", input: { info: { title: "Survey" } }, ok: form })
standardTests(forms, { action: "formsResponses.list", input: { formId: "f1" }, ok: { responses: [{ responseId: "r1" }], nextPageToken: "p2" }, badInput: { formId: "f1", pageSize: "x" } })

test("responses page with pageToken and pageSize", async () => {
  const { conn, calls } = harness(forms, (call) => json(call.url.searchParams.get("pageToken") ? { responses: [] } : { responses: [{ responseId: "r1" }], nextPageToken: "p2" }))
  const first = (await conn.execute("formsResponses.list", { formId: "f1", pageSize: 10 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.pathname, "/v1/forms/f1/responses")
  assert.equal(calls[0]!.url.searchParams.get("pageSize"), "10")
  assert.equal(first.nextCursor, "p2")
  await conn.execute("formsResponses.list", { formId: "f1", cursor: "p2" })
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "p2")
})
