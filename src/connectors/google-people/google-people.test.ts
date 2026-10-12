import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import people from "./index.js"

const person = { resourceName: "people/c123", names: [{ displayName: "Ada Lovelace" }], emailAddresses: [{ value: "ada@acme.dev" }] }

standardTests(people, { action: "connections.list", input: {}, ok: { connections: [person], nextPageToken: "p2" }, badInput: { sortOrder: "RANDOM" } })
standardTests(people, { action: "contacts.search", input: { query: "ada" }, ok: { results: [{ person }] }, badInput: { query: "" } })
standardTests(people, { action: "people.get", input: { resourceName: "people/c123" }, ok: person, badInput: { resourceName: "c123" } })
standardTests(people, { action: "contacts.create", input: { givenName: "Ada", emails: ["ada@acme.dev"] }, ok: person, badInput: { givenName: "" } })

test("a resource name keeps its slash, and the field mask defaults to the useful fields", async () => {
  const { conn, calls } = harness(people, () => json(person))
  await conn.execute("people.get", { resourceName: "people/me" })
  assert.equal(calls[0]!.url.pathname, "/v1/people/me")
  assert.match(calls[0]!.url.searchParams.get("personFields")!, /names,emailAddresses/)
  await conn.execute("people.get", { resourceName: "people/c123", personFields: "birthdays" })
  assert.equal(calls[1]!.url.searchParams.get("personFields"), "birthdays")
})

test("a search is capped at the 30 results Google allows per page", async () => {
  const { conn, calls } = harness(people, () => json({ results: [] }))
  await conn.execute("contacts.search", { query: "ada", pageSize: 100 })
  assert.equal(calls[0]!.url.pathname, "/v1/people:searchContacts")
  assert.equal(calls[0]!.url.searchParams.get("pageSize"), "30")
})

test("creating a contact builds names, emails and phones the way People expects", async () => {
  const { conn, calls } = harness(people, () => json(person))
  await conn.execute("contacts.create", { givenName: "Ada", familyName: "Lovelace", emails: ["ada@acme.dev"], phones: ["+44 20 7946 0000"], company: "Analytical Engines", jobTitle: "Engineer" })
  assert.deepEqual(calls[0]!.body, {
    names: [{ givenName: "Ada", familyName: "Lovelace" }],
    emailAddresses: [{ value: "ada@acme.dev" }],
    phoneNumbers: [{ value: "+44 20 7946 0000" }],
    organizations: [{ name: "Analytical Engines", title: "Engineer" }],
  })
})
