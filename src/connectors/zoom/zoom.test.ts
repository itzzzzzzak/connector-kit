import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import zoom from "./index.js"

const meeting = { id: 85746065, uuid: "abc==", topic: "Standup", type: 2, start_time: "2026-11-01T10:00:00Z", duration: 15, timezone: "UTC", join_url: "https://zoom.us/j/85746065", password: "SECRETPASS", start_url: "https://zoom.us/s/85746065?zak=HOSTTOKEN", encrypted_password: "ENC" }
const page = (meetings: unknown[], token = "") => ({ page_size: 30, total_records: meetings.length, next_page_token: token, meetings })

standardTests(zoom, { action: "meetings.list", input: {}, ok: page([meeting]), badInput: { userId: 5 } })
standardTests(zoom, { action: "meetings.get", input: { meetingId: 85746065 }, ok: meeting, badInput: { meetingId: "abc" } })
standardTests(zoom, { action: "meetings.create", input: { topic: "Standup" }, ok: meeting, badInput: { topic: 5 } })
standardTests(zoom, { action: "recordings.list", input: {}, ok: page([{ id: 1, topic: "Standup", recording_files: [{ id: "f1", file_type: "MP4", file_size: 1024 }] }]), badInput: { userId: 5 } })

test("meetings.list defaults to 'me', pages by next_page_token and keeps the filters; page size caps at 300", async () => {
  const { kit, conn, calls } = harness(zoom, (c) => json(c.url.searchParams.has("next_page_token") ? page([{ ...meeting, id: 2 }]) : page([meeting], "TOKEN2")))
  const ids: number[] = []
  for await (const m of kit.paginate(conn, "meetings.list", { type: "upcoming", pageSize: 5000 })) ids.push(m.id)
  assert.deepEqual(ids, [85746065, 2])
  assert.equal(calls[0]!.url.pathname, "/v2/users/me/meetings")
  assert.equal(calls[0]!.url.searchParams.get("page_size"), "300")
  assert.equal(calls[1]!.url.searchParams.get("next_page_token"), "TOKEN2")
  assert.ok(calls.every((c) => c.url.searchParams.get("type") === "upcoming"))
})

test("an empty next_page_token means the last page", async () => {
  const { conn } = harness(zoom, () => json(page([meeting], "")))
  assert.equal((await conn.execute("meetings.list", {})).nextCursor, null)
})

test("PASSCODES AND HOST START LINKS NEVER REACH THE CALLER, even though Zoom sends them", async () => {
  const { kit, conn } = harness(zoom, () => json(meeting))
  const result = await conn.execute("meetings.get", { meetingId: 85746065 })
  const everything = JSON.stringify(result) + JSON.stringify(await kit.toTools(conn).find((t) => t.name === "zoom_meetings_get")!.run({ meetingId: 85746065 }))
  for (const secret of ["SECRETPASS", "HOSTTOKEN", "ENC", "start_url", "password"]) assert.ok(!everything.includes(secret), `${secret} leaked`)
  assert.equal(result.join_url, "https://zoom.us/j/85746065")
})

test("recording download links are not exposed either", async () => {
  const { conn } = harness(zoom, () => json(page([{ id: 1, topic: "t", share_url: "https://zoom.us/rec/share/SECRETSHARE", recording_files: [{ id: "f1", file_type: "MP4", download_url: "https://zoom.us/rec/download/SECRETDL", play_url: "https://zoom.us/rec/play/SECRETPLAY" }] }])))
  const out = JSON.stringify(await conn.execute("recordings.list", { from: "2026-10-01", to: "2026-10-31" }))
  for (const secret of ["SECRETSHARE", "SECRETDL", "SECRETPLAY"]) assert.ok(!out.includes(secret))
  assert.ok(out.includes("MP4"))
})

test("meetings.create defaults to a scheduled meeting, sends the fields as the body, and is NOT retried", async () => {
  const { conn, calls } = harness(zoom, () => json(meeting, 201), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("meetings.create", { topic: "Standup", start_time: "2026-11-01T10:00:00Z", duration: 15 })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/v2/users/me/meetings")
  assert.deepEqual(calls[0]!.body, { topic: "Standup", type: 2, start_time: "2026-11-01T10:00:00Z", duration: 15 })
})

test("meetings.create refuses an absurd duration or an empty topic before sending anything", async () => {
  const { conn, calls } = harness(zoom, () => json(meeting, 201))
  await assert.rejects(() => conn.execute("meetings.create", { topic: "", }))
  await assert.rejects(() => conn.execute("meetings.create", { topic: "x", duration: 100_000 }))
  assert.equal(calls.length, 0)
})

test("OAuth: Zoom's endpoints with Basic client auth", () => {
  assert.equal(zoom.auth.type, "oauth2")
  if (zoom.auth.type === "oauth2") {
    assert.equal(zoom.auth.authorizeUrl, "https://zoom.us/oauth/authorize")
    assert.equal(zoom.auth.tokenUrl, "https://zoom.us/oauth/token")
    assert.equal(zoom.auth.clientAuth, "basic")
  }
})
