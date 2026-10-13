import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import supabase from "./index.js"

const ref = "abcdefghijklmnopqrst"
const project = { id: ref, name: "app", organization_id: "org1", region: "eu-west-1", status: "ACTIVE_HEALTHY", created_at: "2026-10-01T00:00:00Z" }

standardTests(supabase, { action: "projects.list", input: {}, ok: [project] })
standardTests(supabase, { action: "organizations.list", input: {}, ok: [{ id: "org1", name: "Acme" }] })
standardTests(supabase, { action: "database.readOnlyQuery", input: { ref, query: "select 1" }, ok: [{ "?column?": 1 }], badInput: { ref: "short", query: "select 1" } })
standardTests(supabase, { action: "database.query", input: { ref, query: "select 1" }, ok: [{ "?column?": 1 }], badInput: { ref, query: "" } })
standardTests(supabase, { action: "functions.list", input: { ref }, ok: [{ id: "f1", slug: "hello", name: "hello", status: "ACTIVE", version: 1 }], badInput: { ref: "nope" } })
standardTests(supabase, { action: "storageBuckets.list", input: { ref }, ok: [{ id: "b1", name: "avatars", public: false }], badInput: { ref: "nope" } })

test("a read-only query goes to the read-only endpoint and a normal query to the other", async () => {
  const { conn, calls } = harness(supabase, () => json([]))
  await conn.execute("database.readOnlyQuery", { ref, query: "select 1" })
  await conn.execute("database.query", { ref, query: "select 1" })
  assert.equal(calls[0]!.url.pathname, `/v1/projects/${ref}/database/query/read-only`)
  assert.equal(calls[1]!.url.pathname, `/v1/projects/${ref}/database/query`)
  assert.deepEqual(calls[0]!.body, { query: "select 1" })
})

test("the read-only query is a read and the general query is destructive", () => {
  assert.equal(supabase.actions["database.readOnlyQuery"].effect, "read")
  assert.equal(supabase.actions["database.query"].effect, "destructive")
})

test("endpoints that return API keys or OAuth secrets are not exposed", () => {
  for (const name of Object.keys(supabase.actions)) assert.ok(!/apiKey|oauth/i.test(name), name)
})
