import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import meet from "./index.js"

const space = { name: "spaces/abc", meetingUri: "https://meet.google.com/abc-defg-hij", meetingCode: "abc-defg-hij" }

standardTests(meet, { action: "spaces.create", input: {}, ok: space })
standardTests(meet, { action: "conferenceRecords.list", input: {}, ok: { conferenceRecords: [{ name: "conferenceRecords/c1" }], nextPageToken: "p2" }, badInput: { pageSize: "x" } })

test("creating a space is a POST to /spaces and listing records pages with pageToken", async () => {
  const { conn, calls } = harness(meet, (call) => json(call.url.pathname.endsWith("/spaces") ? space : { conferenceRecords: [] }))
  await conn.execute("spaces.create", {})
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.toString(), "https://meet.googleapis.com/v2/spaces")
  await conn.execute("conferenceRecords.list", { cursor: "p2", pageSize: 5 })
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "p2")
  assert.equal(calls[1]!.url.searchParams.get("pageSize"), "5")
})
