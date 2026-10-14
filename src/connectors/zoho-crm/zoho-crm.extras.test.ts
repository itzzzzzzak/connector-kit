import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import zohoCrm from "./index.js"

// The actions around the records: notes by id, attachments, tags, metadata, users and the organisation.

const connect = { variables: { region: "com" }, credentials: { token: "1000.abcdef.123456" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(zohoCrm, respond, connect)
const ID = "4150868000001234567"
const NOTE = "4150868000007654321"
const page = (records: unknown[], info: Record<string, unknown> = {}) => ({ data: records, info: { per_page: 50, count: records.length, page: 1, more_records: false, ...info } })
const saved = { data: [{ code: "SUCCESS", status: "success", message: "done", details: { id: ID } }] }
type Page = { items: unknown[]; nextCursor: string | null }

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(zohoCrm, { ...c, connect })
std({ action: "leads.convert", input: { id: ID }, ok: saved, badInput: { id: "x" } })
std({ action: "notes.update", input: { noteId: NOTE, content: "changed" }, ok: saved, badInput: { noteId: NOTE } })
std({ action: "notes.delete", input: { noteId: NOTE }, ok: saved, badInput: { noteId: "../x" } })
std({ action: "attachments.list", input: { module: "Leads", id: ID }, ok: page([{ id: NOTE, File_Name: "quote.pdf", Size: 1024 }]), badInput: { module: "Leads", id: "x" } })
std({ action: "attachments.delete", input: { module: "Leads", id: ID, attachmentId: NOTE }, ok: saved, badInput: { module: "Leads", id: ID, attachmentId: "" } })
std({ action: "tags.list", input: { module: "Leads" }, ok: { tags: [{ id: NOTE, name: "vip", color_code: null }], info: { count: 1 } }, badInput: { module: "Le ads" } })
std({ action: "modules.get", input: { module: "Leads" }, ok: { modules: [{ api_name: "Leads", plural_label: "Leads" }] }, badInput: { module: "x/y" } })
std({ action: "layouts.list", input: { module: "Leads" }, ok: { layouts: [{ id: NOTE, name: "Standard", status: "active" }] }, badInput: { module: "" } })
std({ action: "relatedLists.list", input: { module: "Leads" }, ok: { related_lists: [{ id: NOTE, api_name: "Notes", display_label: "Notes", type: "default" }] }, badInput: { module: "Leads", layoutId: "x" } })
std({ action: "customViews.list", input: { module: "Leads" }, ok: { custom_views: [{ id: NOTE, name: "Today", default: false }], info: { count: 1 } }, badInput: { module: 7 } })
std({ action: "roles.list", input: {}, ok: { roles: [{ id: NOTE, name: "CEO", reporting_to: null }] } })
std({ action: "profiles.list", input: {}, ok: { profiles: [{ id: NOTE, name: "Administrator", type: "normal_profile" }] } })
std({ action: "users.list", input: { type: "ActiveUsers" }, ok: { users: [{ id: NOTE, full_name: "Ada", email: "ada@acme.dev", role: { name: "CEO", id: "1" } }], info: { count: 1, more_records: false } }, badInput: { type: "Everyone" } })
std({ action: "users.get", input: { userId: NOTE }, ok: { users: [{ id: NOTE, full_name: "Ada" }] }, badInput: { userId: "x" } })
std({ action: "org.get", input: {}, ok: { org: [{ id: NOTE, company_name: "Acme", time_zone: "Asia/Kolkata", currency: "INR" }] } })

test("notes by id: update sends only what changed, delete takes the id from the path", async () => {
  const update = h(() => json(saved))
  await update.conn.execute("notes.update", { noteId: NOTE, title: "New title" })
  assert.equal(update.calls[0]!.init.method, "PUT")
  assert.equal(update.calls[0]!.url.pathname, `/crm/v8/Notes/${NOTE}`)
  assert.deepEqual(update.calls[0]!.body, { data: [{ Note_Title: "New title" }] })
  const del = h(() => json(saved))
  await del.conn.execute("notes.delete", { noteId: NOTE })
  assert.equal(del.calls[0]!.init.method, "DELETE")
  assert.equal(del.calls[0]!.url.pathname, `/crm/v8/Notes/${NOTE}`)
  assert.equal(del.calls[0]!.init.body, undefined)
})

test("attachments are listed with a default field set and deleted by id; only metadata, never the file", async () => {
  const { conn, calls } = h(() => json(page([{ id: NOTE, File_Name: "quote.pdf", Size: "2048" }])))
  const result = (await conn.execute("attachments.list", { module: "Deals", id: ID })) as { data: { File_Name?: string }[] }
  assert.equal(calls[0]!.url.pathname, `/crm/v8/Deals/${ID}/Attachments`)
  assert.equal(calls[0]!.url.searchParams.get("fields"), "id,File_Name,Size,Created_Time,Owner")
  assert.equal(result.data[0]!.File_Name, "quote.pdf")
  const del = h(() => json(saved))
  await del.conn.execute("attachments.delete", { module: "Deals", id: ID, attachmentId: NOTE })
  assert.equal(del.calls[0]!.url.pathname, `/crm/v8/Deals/${ID}/Attachments/${NOTE}`)
  assert.equal(del.calls[0]!.init.method, "DELETE")
})

test("an empty 204 answer is an empty result for attachments and a list of users", async () => {
  const { conn } = h(() => new Response(null, { status: 204 }))
  assert.deepEqual(await conn.execute("attachments.list", { module: "Leads", id: ID }), { data: [] })
  assert.deepEqual(await conn.execute("users.list", {}), { items: [], nextCursor: null })
})

test("metadata tools pass the module as a query parameter", async () => {
  for (const [action, path, extra] of [
    ["tags.list", "/crm/v8/settings/tags", { myTags: true }],
    ["layouts.list", "/crm/v8/settings/layouts", {}],
    ["relatedLists.list", "/crm/v8/settings/related_lists", { layoutId: NOTE }],
    ["customViews.list", "/crm/v8/settings/custom_views", {}],
    ["fields.list", "/crm/v8/settings/fields", {}],
  ] as const) {
    const { conn, calls } = h(() => json({ tags: [], layouts: [], related_lists: [], custom_views: [], fields: [] }))
    await conn.execute(action as never, { module: "Deals", ...extra } as never)
    assert.equal(calls[0]!.url.pathname, path, action)
    assert.equal(calls[0]!.url.searchParams.get("module"), "Deals", action)
  }
  const tags = h(() => json({ tags: [] }))
  await tags.conn.execute("tags.list", { module: "Deals", myTags: true })
  assert.equal(tags.calls[0]!.url.searchParams.get("my_tags"), "true")
  const related = h(() => json({ related_lists: [] }))
  await related.conn.execute("relatedLists.list", { module: "Deals", layoutId: NOTE })
  assert.equal(related.calls[0]!.url.searchParams.get("layout_id"), NOTE)
})

test("modules.get puts the module in the path; roles and profiles are plain lists", async () => {
  const one = h(() => json({ modules: [{ api_name: "Deals" }] }))
  await one.conn.execute("modules.get", { module: "Deals" })
  assert.equal(one.calls[0]!.url.pathname, "/crm/v8/settings/modules/Deals")
  const roles = h(() => json({ roles: [] }))
  await roles.conn.execute("roles.list", {})
  assert.equal(roles.calls[0]!.url.pathname, "/crm/v8/settings/roles")
  const profiles = h(() => json({ profiles: [] }))
  await profiles.conn.execute("profiles.list", {})
  assert.equal(profiles.calls[0]!.url.pathname, "/crm/v8/settings/profiles")
})

test("users page by number and filter by type; one user and the organisation come out of Zoho's arrays", async () => {
  const { conn, calls } = h((call) => json(call.url.pathname === "/crm/v8/users" ? { users: [{ id: NOTE, full_name: "Ada" }], info: { page: 1, per_page: 200, more_records: true } } : { users: [{ id: NOTE, full_name: "Ada" }] }))
  const list = (await conn.execute("users.list", { type: "AdminUsers", pageSize: 200 })) as Page
  assert.equal(calls[0]!.url.searchParams.get("type"), "AdminUsers")
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "200")
  assert.equal(list.nextCursor, "2")
  assert.deepEqual(await conn.execute("users.get", { userId: NOTE }), { id: NOTE, full_name: "Ada" })
  assert.equal(calls[1]!.url.pathname, `/crm/v8/users/${NOTE}`)
  const org = h(() => json({ org: [{ id: NOTE, company_name: "Acme", time_zone: "Asia/Kolkata", currency: "INR", country: "India" }] }))
  const result = (await org.conn.execute("org.get", {})) as { company_name?: string; time_zone?: string }
  assert.equal(org.calls[0]!.url.pathname, "/crm/v8/org")
  assert.equal(result.company_name, "Acme")
  assert.equal(result.time_zone, "Asia/Kolkata")
})

test("notes.update needs something to change, and nothing is sent when it does not", async () => {
  const { conn, calls } = h(() => json(saved))
  await assert.rejects(() => conn.execute("notes.update", { noteId: NOTE }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("only deletes are destructive: records, notes and attachments", () => {
  const destructive = Object.entries(zohoCrm.actions).filter(([, a]) => a.effect === "destructive").map(([name]) => name)
  for (const name of destructive) assert.equal(zohoCrm.actions[name]!.method, "DELETE", name)
  for (const [name, a] of Object.entries(zohoCrm.actions)) if (a.method === "DELETE") assert.equal(a.effect, "destructive", name)
  assert.ok(destructive.includes("notes.delete") && destructive.includes("attachments.delete") && destructive.includes("record.delete") && destructive.includes("leads.delete"))
})

test("no write is marked safe to retry", () => {
  for (const [name, a] of Object.entries(zohoCrm.actions)) assert.ok(!a.safeToRetry, name)
})
