import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import mailchimp from "./index.js"

const connect = { variables: { dc: "us19" }, credentials: { token: "anystring:abc123-us19" } }
const member = { id: "5ce3b9f0", email_address: "ada@x.dev", status: "subscribed", merge_fields: { FNAME: "Ada", LNAME: "L" }, list_id: "L1", tags: [{ id: 1, name: "vip" }], vip: false }
const aud = { id: "L1", name: "Newsletter", date_created: "2026-01-01T00:00:00+00:00", stats: { member_count: 120, open_rate: 0.4 } }
const camp = { id: "C1", type: "regular", status: "sent", send_time: "2026-10-01T10:00:00+00:00", emails_sent: 120, recipients: { list_id: "L1", recipient_count: 120 }, settings: { subject_line: "Hello", title: "Oct news" }, report_summary: { opens: 50, open_rate: 0.41 } }

standardTests(mailchimp, { action: "ping.get", input: {}, ok: { health_status: "Everything's Chimpy!" }, connect })
standardTests(mailchimp, { action: "lists.list", input: {}, ok: { lists: [aud], total_items: 1 }, badInput: { sort_dir: "UP" }, connect })
standardTests(mailchimp, { action: "lists.get", input: { list_id: "L1" }, ok: aud, badInput: { list_id: 5 }, connect })
standardTests(mailchimp, { action: "members.list", input: { list_id: "L1" }, ok: { members: [member], list_id: "L1", total_items: 1 }, badInput: { list_id: "L1", status: "gone" }, connect })
standardTests(mailchimp, { action: "members.get", input: { list_id: "L1", subscriber_hash: "ada@x.dev" }, ok: member, badInput: { list_id: "L1", subscriber_hash: 5 }, connect })
standardTests(mailchimp, { action: "members.upsert", input: { list_id: "L1", subscriber_hash: "ada@x.dev", email_address: "ada@x.dev", status_if_new: "pending" }, ok: member, badInput: { list_id: "L1", subscriber_hash: "ada@x.dev", email_address: "not-an-email", status_if_new: "pending" }, connect })
standardTests(mailchimp, { action: "campaigns.list", input: {}, ok: { campaigns: [camp], total_items: 1 }, badInput: { status: "gone" }, connect })
standardTests(mailchimp, { action: "campaigns.get", input: { campaign_id: "C1" }, ok: camp, badInput: { campaign_id: 5 }, connect })

const h = (respond: Parameters<typeof harness>[1], opts = {}) => harness(mailchimp, respond, { ...connect, ...opts })

test("requests go to the key's data center with Basic 'anystring:KEY'", async () => {
  const { conn, calls } = h(() => json({ health_status: "ok" }))
  await conn.execute("ping.get", {})
  assert.equal(calls[0]!.url.toString(), "https://us19.api.mailchimp.com/3.0/ping")
  assert.equal(calls[0]!.header("authorization"), `Basic ${Buffer.from("anystring:abc123-us19").toString("base64")}`)
})

test("the data center must look like one (us19, eu1...): anything else is refused before any request", () => {
  for (const dc of ["evil.com/x", "us19.evil.com", "US19", "usa19", "", "u1", "us190", "us-19"]) assert.throws(() => harness(mailchimp, () => json({}), { ...connect, variables: { dc } }), /not valid/, dc)
  for (const dc of ["us1", "us19", "eu2"]) harness(mailchimp, () => json({}), { ...connect, variables: { dc } })
})

test("lists page by count/offset using total_items: the last page is recognised exactly", async () => {
  const { kit, conn, calls } = h((c) => {
    const offset = Number(c.url.searchParams.get("offset") ?? 0)
    return json({ lists: [{ ...aud, id: `L${offset}` }], total_items: 45 })
  })
  let got = 0
  const seen: string[] = []
  for await (const a of kit.paginate(conn, "lists.list", { pageSize: 20 })) {
    seen.push(a.id)
    if (++got > 100) break
  }
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("offset")), [null, "20", "40"])
  assert.ok(calls.every((c) => c.url.searchParams.get("count") === "20"))
  assert.equal(calls.length, 3)
})

test("members.list keeps the audience in the path and the filters on every page; count caps at 100", async () => {
  const { conn, calls } = h(() => json({ members: [member], list_id: "L1", total_items: 1 }))
  await conn.execute("members.list", { list_id: "L1", status: "unsubscribed", since_last_changed: "2026-10-01T00:00:00Z", pageSize: 5000 })
  assert.equal(calls[0]!.url.pathname, "/3.0/lists/L1/members")
  assert.equal(calls[0]!.url.searchParams.get("status"), "unsubscribed")
  assert.equal(calls[0]!.url.searchParams.get("count"), "100")
})

test("a member is looked up by email directly: the address is percent-encoded in the path", async () => {
  const { conn, calls } = h(() => json(member))
  await conn.execute("members.get", { list_id: "L1", subscriber_hash: "ada+tag@x.dev" })
  assert.equal(calls[0]!.url.pathname, "/3.0/lists/L1/members/ada%2Btag%40x.dev")
})

test("members.upsert is a PUT: the subscriber is only in the path, the status for NEW people is required and sent", async () => {
  const { conn, calls } = h(() => json(member))
  await conn.execute("members.upsert", { list_id: "L1", subscriber_hash: "ada@x.dev", email_address: "ada@x.dev", status_if_new: "pending", merge_fields: { FNAME: "Ada" }, vip: true })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.equal(calls[0]!.url.pathname, "/3.0/lists/L1/members/ada%40x.dev")
  assert.deepEqual(calls[0]!.body, { email_address: "ada@x.dev", status_if_new: "pending", merge_fields: { FNAME: "Ada" }, vip: true })
})

test("members.upsert refuses to run without an explicit status for new members (no silent subscribe)", async () => {
  const { conn, calls } = h(() => json(member))
  await assert.rejects(() => conn.execute("members.upsert", { list_id: "L1", subscriber_hash: "ada@x.dev", email_address: "ada@x.dev" } as never))
  assert.equal(calls.length, 0)
  assert.match(mailchimp.actions["members.upsert"].description, /consent/)
})

test("members.upsert IS retried (an 'add or update' PUT leaves the member in the same state)", async () => {
  let n = 0
  const { conn, calls } = h(() => (++n === 1 ? json({}, 503) : json(member)), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("members.upsert", { list_id: "L1", subscriber_hash: "ada@x.dev", email_address: "ada@x.dev", status_if_new: "pending" })
  assert.equal(calls.length, 2)
})

test("the API key never appears in an error (nor its Base64 form)", async () => {
  const { conn } = h(() => json({ title: "API Key Invalid", status: 401 }, 401))
  await assert.rejects(() => conn.execute("lists.list", {}), (e: unknown) => {
    const text = JSON.stringify(e) + (e as Error).message
    return !text.includes("abc123") && !text.includes(Buffer.from("anystring:abc123-us19").toString("base64"))
  })
})
