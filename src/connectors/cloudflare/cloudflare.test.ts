import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import cloudflare from "./index.js"

const zoneId = "023e105f4ecef8ad9ca31a8372d0c353"
const recordId = "372e67954025e0ba6aaa6d586b9e0b59"
const zone = { id: zoneId, name: "example.com", status: "active", paused: false, name_servers: ["a.ns.cloudflare.com"] }
const record = { id: recordId, type: "A", name: "www.example.com", content: "198.51.100.4", ttl: 1, proxied: true }
const list = (result: unknown[], total = result.length) => ({ success: true, result, result_info: { page: 1, per_page: 20, total_count: total } })

standardTests(cloudflare, { action: "token.verify", input: {}, ok: { success: true, result: { id: "t1", status: "active" } } })
standardTests(cloudflare, { action: "accounts.list", input: {}, ok: list([{ id: zoneId, name: "Acme" }]), badInput: { pageSize: 1 } })
standardTests(cloudflare, { action: "zones.list", input: {}, ok: list([zone]), badInput: { status: "gone" } })
standardTests(cloudflare, { action: "zone.get", input: { zoneId }, ok: { success: true, result: zone }, badInput: { zoneId: "example.com" } })
standardTests(cloudflare, { action: "zoneSettings.list", input: { zoneId }, ok: { success: true, result: [{ id: "ssl", value: "full", editable: true }] }, badInput: { zoneId: "x" } })
standardTests(cloudflare, { action: "dnsRecords.list", input: { zoneId }, ok: list([record]), badInput: { zoneId, type: "BOGUS" } })
standardTests(cloudflare, { action: "dnsRecord.get", input: { zoneId, recordId }, ok: { success: true, result: record }, badInput: { zoneId, recordId: "" } })
standardTests(cloudflare, { action: "dnsRecord.create", input: { zoneId, type: "A", name: "www", content: "198.51.100.4" }, ok: { success: true, result: record }, badInput: { zoneId, type: "MX", name: "@", content: "mail.example.com" } })
standardTests(cloudflare, { action: "dnsRecord.update", input: { zoneId, recordId, content: "198.51.100.5" }, ok: { success: true, result: record }, badInput: { zoneId, recordId, ttl: 0 } })
standardTests(cloudflare, { action: "dnsRecord.delete", input: { zoneId, recordId }, ok: { success: true, result: { id: recordId } }, badInput: { zoneId, recordId: "" } })
standardTests(cloudflare, { action: "cache.purge", input: { zoneId, purgeEverything: true }, ok: { success: true, result: { id: zoneId } }, badInput: { zoneId } })
standardTests(cloudflare, { action: "workers.list", input: { accountId: zoneId }, ok: { success: true, result: [{ id: "my-worker", modified_on: "2026-10-01T00:00:00Z" }] }, badInput: { accountId: "x" } })

test("creating a record sends the record fields in the body and the zone in the path", async () => {
  const { conn, calls } = harness(cloudflare, () => json({ success: true, result: record }))
  await conn.execute("dnsRecord.create", { zoneId, type: "MX", name: "@", content: "mail.example.com", priority: 10, ttl: 300 })
  assert.equal(calls[0]!.url.pathname, `/client/v4/zones/${zoneId}/dns_records`)
  assert.deepEqual(calls[0]!.body, { type: "MX", name: "@", content: "mail.example.com", priority: 10, ttl: 300 })
})

test("updating a record sends only the fields given, as PATCH", async () => {
  const { conn, calls } = harness(cloudflare, () => json({ success: true, result: record }))
  await conn.execute("dnsRecord.update", { zoneId, recordId, proxied: false })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.deepEqual(calls[0]!.body, { proxied: false })
})

test("a purge sends exactly one option, and purge-everything uses Cloudflare's field name", async () => {
  const { conn, calls } = harness(cloudflare, () => json({ success: true, result: { id: zoneId } }))
  await conn.execute("cache.purge", { zoneId, purgeEverything: true })
  await conn.execute("cache.purge", { zoneId, files: ["https://example.com/a.css"] })
  assert.deepEqual(calls[0]!.body, { purge_everything: true })
  assert.deepEqual(calls[1]!.body, { files: ["https://example.com/a.css"] })
  await assert.rejects(() => conn.execute("cache.purge", { zoneId, purgeEverything: true, hosts: ["example.com"] }), /exactly one/)
  assert.equal(calls.length, 2)
})

test("zone filters use Cloudflare's dotted account.id query name", async () => {
  const { conn, calls } = harness(cloudflare, () => json(list([zone])))
  await conn.execute("zones.list", { name: "example.com", accountId: zoneId })
  assert.equal(calls[0]!.url.searchParams.get("account.id"), zoneId)
  assert.equal(calls[0]!.url.searchParams.get("name"), "example.com")
})

test("lists page by number and stop when the total is reached", async () => {
  const more = harness(cloudflare, () => json(list([zone, { ...zone, id: "b".repeat(32) }], 8)))
  const page = (await more.conn.execute("zones.list", { pageSize: 5 })) as { nextCursor: string | null }
  assert.equal(more.calls[0]!.url.searchParams.get("per_page"), "5")
  assert.equal(page.nextCursor, "2")
  const last = harness(cloudflare, () => json(list([zone], 1)))
  assert.equal(((await last.conn.execute("zones.list", {})) as { nextCursor: string | null }).nextCursor, null)
})

test("deleting a record and purging the cache are destructive; creating is a write", () => {
  assert.equal(cloudflare.actions["dnsRecord.delete"].effect, "destructive")
  assert.equal(cloudflare.actions["cache.purge"].effect, "destructive")
  assert.equal(cloudflare.actions["dnsRecord.create"].effect, "write")
})
