import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import digitalocean from "./index.js"

const droplet = { id: 3164444, name: "web-1", status: "active", memory: 1024, vcpus: 1, disk: 25, locked: false, created_at: "2026-01-01T00:00:00Z", size_slug: "s-1vcpu-1gb", region: { slug: "nyc3", name: "New York 3" }, image: { id: 1, name: "22.04", distribution: "Ubuntu", slug: "ubuntu-22-04-x64" }, tags: ["web"], networks: { v4: [{ ip_address: "203.0.113.10", type: "public" }], v6: [] } }
const list = (key: string, items: unknown[], next?: string) => ({ [key]: items, links: next ? { pages: { next, last: next } } : {}, meta: { total: items.length } })

standardTests(digitalocean, { action: "account.get", input: {}, ok: { account: { email: "a@b.dev", uuid: "u1", status: "active", droplet_limit: 25 } } })
standardTests(digitalocean, { action: "droplets.list", input: {}, ok: list("droplets", [droplet]), badInput: { tag_name: 5 } })
standardTests(digitalocean, { action: "droplets.get", input: { droplet_id: 3164444 }, ok: { droplet }, badInput: { droplet_id: "abc" } })
standardTests(digitalocean, { action: "domains.list", input: {}, ok: list("domains", [{ name: "example.com", ttl: 1800 }]), badInput: { pageSize: "x" } })
standardTests(digitalocean, { action: "domains.records.list", input: { domain_name: "example.com" }, ok: list("domain_records", [{ id: 1, type: "A", name: "@", data: "203.0.113.10", ttl: 1800 }]), badInput: { domain_name: 5 } })

test("droplets.list reads the 'droplets' list and follows links.pages.next (a full URL), keeping the filters", async () => {
  const { kit, conn, calls } = harness(digitalocean, (c) =>
    c.url.searchParams.get("page") === "2" ? json(list("droplets", [{ ...droplet, id: 2, name: "web-2" }])) : json(list("droplets", [droplet], "https://api.digitalocean.com/v2/droplets?page=2&per_page=30&tag_name=web")),
  )
  const names: string[] = []
  for await (const d of kit.paginate(conn, "droplets.list", { tag_name: "web" })) names.push(d.name)
  assert.deepEqual(names, ["web-1", "web-2"])
  assert.equal(calls[0]!.url.pathname, "/v2/droplets")
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "30")
  assert.equal(calls[0]!.url.searchParams.get("tag_name"), "web")
  assert.equal(calls[1]!.url.toString(), "https://api.digitalocean.com/v2/droplets?page=2&per_page=30&tag_name=web")
  assert.equal(calls[1]!.header("authorization"), "Bearer test-token", "the token must follow the next-page link")
})

test("a next link pointing at another host is refused (it would carry the token there)", async () => {
  const { conn } = harness(digitalocean, () => json(list("droplets", [droplet], "https://attacker.example.net/v2/droplets?page=2")))
  await assert.rejects(() => conn.execute("droplets.list", {}), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("page size is capped at 200", async () => {
  const { conn, calls } = harness(digitalocean, () => json(list("domains", [])))
  await conn.execute("domains.list", { pageSize: 9999 })
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "200")
})

test("droplets.get puts the numeric id in the path; a non-integer id is rejected locally", async () => {
  const { conn, calls } = harness(digitalocean, () => json({ droplet }))
  const result = await conn.execute("droplets.get", { droplet_id: 3164444 })
  assert.equal(result.droplet.networks?.v4?.[0]?.ip_address, "203.0.113.10")
  assert.equal(calls[0]!.url.pathname, "/v2/droplets/3164444")
  await assert.rejects(() => conn.execute("droplets.get", { droplet_id: 1.5 }))
  await assert.rejects(() => conn.execute("droplets.get", { droplet_id: -1 }))
  assert.equal(calls.length, 1)
})

test("DNS records: domain in the path (encoded), type and name as filters", async () => {
  const { conn, calls } = harness(digitalocean, () => json(list("domain_records", [{ id: 9, type: "MX", name: "@", data: "mail.example.com.", priority: 10, ttl: 300 }])))
  const page = await conn.execute("domains.records.list", { domain_name: "example.com", type: "MX" })
  assert.equal(page.items[0]!.priority, 10)
  assert.equal(calls[0]!.url.pathname, "/v2/domains/example.com/records")
  assert.equal(calls[0]!.url.searchParams.get("type"), "MX")
})

test("every action is a read: this connector cannot change anything", () => {
  assert.ok(Object.values(digitalocean.actions).every((a) => a.effect === "read"))
})

test("OAuth: DigitalOcean's endpoints, client credentials in the body, read scope by default", () => {
  assert.equal(digitalocean.auth.type, "oauth2")
  if (digitalocean.auth.type === "oauth2") {
    assert.equal(digitalocean.auth.authorizeUrl, "https://cloud.digitalocean.com/v1/oauth/authorize")
    assert.equal(digitalocean.auth.tokenUrl, "https://cloud.digitalocean.com/v1/oauth/token")
    assert.notEqual(digitalocean.auth.clientAuth, "basic")
    assert.deepEqual(digitalocean.auth.scopes, ["read"])
  }
})
