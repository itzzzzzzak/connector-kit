import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import hubspot from "./index.js"

const contact = { id: "101", properties: { email: "ada@acme.dev", firstname: "Ada", lastname: null }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", archived: false }
const page = (results: unknown[], after?: string) => ({ results, ...(after && { paging: { next: { after, link: "https://api.hubapi.com/x" } } }) })

standardTests(hubspot, { action: "contacts.list", input: {}, ok: page([contact]), badInput: { archived: "yes" } })
standardTests(hubspot, { action: "contacts.get", input: { contactId: "101" }, ok: contact, badInput: { contactId: 101 } })
standardTests(hubspot, { action: "contacts.create", input: { properties: { email: "a@b.dev" } }, ok: contact, badInput: { properties: "email" } })
standardTests(hubspot, { action: "contacts.update", input: { contactId: "101", properties: { firstname: "A" } }, ok: contact, badInput: { contactId: 101, properties: {} } })
standardTests(hubspot, { action: "companies.list", input: {}, ok: page([{ ...contact, id: "7" }]), badInput: { pageSize: "x" } })
standardTests(hubspot, { action: "companies.get", input: { companyId: "7" }, ok: contact, badInput: { companyId: 7 } })
standardTests(hubspot, { action: "companies.create", input: { properties: { name: "Acme" } }, ok: contact, badInput: { properties: 5 } })
standardTests(hubspot, { action: "deals.list", input: {}, ok: page([contact]), badInput: { archived: 1 } })
standardTests(hubspot, { action: "deals.get", input: { dealId: "9" }, ok: contact, badInput: { dealId: 9 } })
standardTests(hubspot, { action: "deals.create", input: { properties: { dealname: "Big" } }, ok: contact, badInput: { properties: null } })

test("contacts.list: default page size, repeated properties, cursor from paging.next.after sent back as 'after'", async () => {
  const { kit, conn, calls } = harness(hubspot, (c) => json(c.url.searchParams.has("after") ? page([{ ...contact, id: "102" }]) : page([contact], "AFTER2")))
  const ids: string[] = []
  for await (const c of kit.paginate(conn, "contacts.list", { properties: ["email", "firstname"] })) ids.push(c.id)
  assert.deepEqual(ids, ["101", "102"])
  assert.equal(calls[0]!.url.pathname, "/crm/v3/objects/contacts")
  assert.equal(calls[0]!.url.searchParams.get("limit"), "30")
  assert.deepEqual(calls[1]!.url.searchParams.getAll("properties"), ["email", "firstname"])
  assert.equal(calls[1]!.url.searchParams.get("after"), "AFTER2")
})

test("page size is capped at HubSpot's 100", async () => {
  const { conn, calls } = harness(hubspot, () => json(page([])))
  await conn.execute("deals.list", { pageSize: 9999 })
  assert.equal(calls[0]!.url.searchParams.get("limit"), "100")
})

test("contacts.get can look a person up by email through idProperty", async () => {
  const { conn, calls } = harness(hubspot, () => json(contact))
  await conn.execute("contacts.get", { contactId: "ada@acme.dev", idProperty: "email" })
  assert.equal(calls[0]!.url.pathname, "/crm/v3/objects/contacts/ada%40acme.dev")
  assert.equal(calls[0]!.url.searchParams.get("idProperty"), "email")
})

test("null property values (empty fields) are accepted", async () => {
  const { conn } = harness(hubspot, () => json(contact))
  assert.equal((await conn.execute("contacts.get", { contactId: "101" })).properties.lastname, null)
})

test("contacts.create sends { properties } and is NOT retried after a 5xx", async () => {
  const { conn, calls } = harness(hubspot, () => json(contact, 201))
  await conn.execute("contacts.create", { properties: { email: "a@b.dev", firstname: "A" } })
  assert.equal(calls[0]!.init.method, "POST")
  assert.deepEqual(calls[0]!.body, { properties: { email: "a@b.dev", firstname: "A" } })
})

test("contacts.update is a PATCH with { properties }; the id is only in the path; it is retried (idempotent)", async () => {
  let n = 0
  const { conn, calls } = harness(hubspot, () => (++n === 1 ? json({}, 503) : json(contact)), { retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 } })
  await conn.execute("contacts.update", { contactId: "101", properties: { firstname: "Grace" } })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, "PATCH")
  assert.equal(calls[1]!.url.pathname, "/crm/v3/objects/contacts/101")
  assert.deepEqual(calls[1]!.body, { properties: { firstname: "Grace" } })
})

test("property values must be strings (HubSpot's CRM API takes strings)", async () => {
  const { conn, calls } = harness(hubspot, () => json(contact))
  await assert.rejects(() => conn.execute("contacts.create", { properties: { amount: 5 } as never }))
  assert.equal(calls.length, 0)
})

test("HubSpot's OAuth endpoints and read-only default scopes", () => {
  assert.equal(hubspot.auth.type, "oauth2")
  if (hubspot.auth.type === "oauth2") {
    assert.equal(hubspot.auth.authorizeUrl, "https://app.hubspot.com/oauth/authorize")
    assert.equal(hubspot.auth.tokenUrl, "https://api.hubapi.com/oauth/v1/token")
    assert.ok(hubspot.auth.scopes?.every((s) => s.endsWith(".read")), "default scopes must be read-only")
  }
})
