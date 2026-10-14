import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import zohoCrm from "./index.js"
import { GENERIC_NAMES, MODULES, moduleNames, type RecordVerb } from "./modules.js"

// Every standard module gets the same record tools, so they are tested the same way: the failure paths for each action through
// standardTests, then what is specific to the module (its path) for every verb.

const connect = { variables: { region: "com" }, credentials: { token: "1000.abcdef.123456" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(zohoCrm, respond, connect)
const ID = "4150868000001234567"
const NOTE = "4150868000007654321"
const page = (records: unknown[], info: Record<string, unknown> = {}) => ({ data: records, info: { per_page: 50, count: records.length, page: 1, more_records: false, ...info } })
const saved = { data: [{ code: "SUCCESS", status: "success", message: "done", details: { id: ID } }] }
type Page = { items: unknown[]; nextCursor: string | null }

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(zohoCrm, { ...c, connect })

/** Valid input, a realistic answer and a bad input for each verb of the record tools. */
const cases: Record<RecordVerb, { input: Record<string, unknown>; ok: unknown; bad?: Record<string, unknown> }> = {
  list: { input: { fields: ["Last_Name"] }, ok: page([{ id: ID }]), bad: { fields: "Last_Name" } },
  search: { input: { word: "acme" }, ok: page([{ id: ID }]), bad: { word: 5 } },
  get: { input: { id: ID }, ok: { data: [{ id: ID }] }, bad: { id: "../x" } },
  create: { input: { fields: { Name: "x" } }, ok: saved, bad: { fields: "x" } },
  update: { input: { id: ID, fields: { Name: "x" } }, ok: saved, bad: { id: ID, fields: {} } },
  upsert: { input: { fields: { Email: "a@b.co" } }, ok: { data: [{ code: "SUCCESS", status: "success", action: "insert", details: { id: ID } }] }, bad: { fields: {} } },
  delete: { input: { id: ID }, ok: saved, bad: { id: "" } },
  deleted: { input: { type: "recycle" }, ok: page([{ id: ID, display_name: "x", type: "recycle" }]), bad: { type: "gone" } },
  related: { input: { id: ID, relatedList: "Notes", fields: ["Note_Content"] }, ok: page([{ id: NOTE }]), bad: { id: ID, relatedList: "../x", fields: ["A"] } },
  notesList: { input: { id: ID }, ok: page([{ id: NOTE, Note_Content: "hi" }]), bad: { id: "x" } },
  notesAdd: { input: { id: ID, content: "called" }, ok: saved, bad: { id: ID, content: "" } },
  tagsAdd: { input: { id: ID, tags: ["vip"] }, ok: saved, bad: { id: ID, tags: [] } },
  tagsRemove: { input: { id: ID, tags: ["vip"] }, ok: saved, bad: { id: ID, tags: "vip" } },
}
const verbs = Object.keys(cases) as RecordVerb[]
const pathOf: Record<RecordVerb, (api: string) => string> = {
  list: (api) => `/crm/v8/${api}`,
  search: (api) => `/crm/v8/${api}/search`,
  get: (api) => `/crm/v8/${api}/${ID}`,
  create: (api) => `/crm/v8/${api}`,
  update: (api) => `/crm/v8/${api}/${ID}`,
  upsert: (api) => `/crm/v8/${api}/upsert`,
  delete: (api) => `/crm/v8/${api}/${ID}`,
  deleted: (api) => `/crm/v8/${api}/deleted`,
  related: (api) => `/crm/v8/${api}/${ID}/Notes`,
  notesList: (api) => `/crm/v8/${api}/${ID}/Notes`,
  notesAdd: () => "/crm/v8/Notes",
  tagsAdd: (api) => `/crm/v8/${api}/${ID}/actions/add_tags`,
  tagsRemove: (api) => `/crm/v8/${api}/${ID}/actions/remove_tags`,
}
const methodOf: Record<RecordVerb, string> = { list: "GET", search: "GET", get: "GET", create: "POST", update: "PUT", upsert: "POST", delete: "DELETE", deleted: "GET", related: "GET", notesList: "GET", notesAdd: "POST", tagsAdd: "POST", tagsRemove: "POST" }
const effectOf: Record<RecordVerb, string> = { list: "read", search: "read", get: "read", create: "write", update: "write", upsert: "write", delete: "destructive", deleted: "read", related: "read", notesList: "read", notesAdd: "write", tagsAdd: "write", tagsRemove: "write" }

// The generic tools take the module as an input, and so reach custom modules too.
for (const verb of verbs) {
  const c = cases[verb]
  const connectInput = { module: "Custom_Things", ...c.input }
  std({ action: GENERIC_NAMES[verb], input: connectInput, ok: c.ok, ...(c.bad && { badInput: { module: "Custom_Things", ...c.bad } }) })
}

test("the generic tools send the caller's module, including a custom one, in the path", async () => {
  for (const verb of verbs) {
    const { conn, calls } = h(() => json(cases[verb].ok))
    await conn.execute(GENERIC_NAMES[verb] as never, { module: "Custom_Things", ...cases[verb].input } as never)
    assert.equal(calls[0]!.url.pathname, pathOf[verb]("Custom_Things"), `${GENERIC_NAMES[verb]} path`)
    assert.equal(calls[0]!.init.method, methodOf[verb])
  }
  const { conn } = h(() => json(saved))
  await assert.rejects(() => conn.execute("record.create", { module: "Bad/Module", fields: { A: 1 } } as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

for (const m of MODULES) {
  const names = moduleNames(m.group)
  for (const verb of verbs) {
    const c = cases[verb]
    std({ action: names[verb], input: c.input, ok: c.ok, ...(c.bad && { badInput: c.bad }) })
  }

  test(`${m.group}: every tool goes to ${m.api} with the right method and effect`, async () => {
    for (const verb of verbs) {
      const { conn, calls } = h(() => json(cases[verb].ok))
      await conn.execute(names[verb] as never, cases[verb].input as never)
      assert.equal(calls[0]!.url.pathname, pathOf[verb](m.api), `${names[verb]} path`)
      assert.equal(calls[0]!.init.method, methodOf[verb], `${names[verb]} method`)
      assert.equal(zohoCrm.actions[names[verb]]!.effect, effectOf[verb], `${names[verb]} effect`)
    }
  })

  test(`${m.group}: the related tool takes the related list name in the path, and notes.add names this module as the parent`, async () => {
    const related = h(() => json(page([])))
    await related.conn.execute(names.related as never, { id: ID, relatedList: "Contacts", fields: ["Last_Name", "Email"] } as never)
    assert.equal(related.calls[0]!.url.pathname, `/crm/v8/${m.api}/${ID}/Contacts`)
    assert.equal(related.calls[0]!.url.searchParams.get("fields"), "Last_Name,Email")
    const note = h(() => json(saved))
    await note.conn.execute(names.notesAdd as never, { id: ID, content: "called", title: "Call" } as never)
    assert.deepEqual(note.calls[0]!.body, { data: [{ Parent_Id: { module: { api_name: m.api }, id: ID }, Note_Content: "called", Note_Title: "Call" }] })
  })
}

test("tool names are unique, valid, and each module has its own group", () => {
  const names = Object.keys(zohoCrm.actions)
  assert.equal(new Set(names).size, names.length)
  for (const m of MODULES) {
    assert.equal(names.filter((n) => n.startsWith(`${m.group}.`)).length, verbs.length + (m.group === "leads" ? 1 : 0), m.group)
  }
  assert.equal(new Set(MODULES.map((m) => m.group)).size, MODULES.length)
  assert.equal(new Set(MODULES.map((m) => m.api)).size, MODULES.length)
})

test("a module's list tool pages and keeps the field list, like the generic one", async () => {
  const { conn, calls } = h((call) => json(call.url.searchParams.get("page") === "2" ? page([{ id: ID }], { page: 2 }) : page([{ id: ID }], { more_records: true })))
  const first = (await conn.execute("deals.list", { fields: ["Deal_Name", "Stage"], pageSize: 50 })) as Page
  assert.equal(first.nextCursor, "p:2")
  const second = (await conn.execute("deals.list", { fields: ["Deal_Name", "Stage"], pageSize: 50, cursor: first.nextCursor! })) as Page
  assert.equal(calls[1]!.url.pathname, "/crm/v8/Deals")
  assert.equal(calls[1]!.url.searchParams.get("fields"), "Deal_Name,Stage")
  assert.equal(second.nextCursor, null)
})

test("a multi-word module keeps its underscore API name in the path: Sales_Orders, Purchase_Orders, Price_Books", async () => {
  for (const [action, api] of [["salesOrders.list", "Sales_Orders"], ["purchaseOrders.list", "Purchase_Orders"], ["priceBooks.list", "Price_Books"]] as const) {
    const { conn, calls } = h(() => json(page([])))
    await conn.execute(action as never, { fields: ["Subject"] } as never)
    assert.equal(calls[0]!.url.pathname, `/crm/v8/${api}`)
  }
})

test("upsert sends the duplicate check fields in order", async () => {
  const { conn, calls } = h(() => json({ data: [{ code: "SUCCESS", status: "success", action: "update", details: { id: ID } }] }))
  await conn.execute("contacts.upsert", { fields: { Email: "ada@acme.dev", Last_Name: "Lovelace" }, duplicateCheckFields: ["Email", "Phone"] })
  assert.equal(calls[0]!.url.pathname, "/crm/v8/Contacts/upsert")
  assert.deepEqual(calls[0]!.body, { data: [{ Email: "ada@acme.dev", Last_Name: "Lovelace" }], duplicate_check_fields: ["Email", "Phone"] })
})

test("deleted records can be filtered by type, and page by page", async () => {
  const { conn, calls } = h(() => json(page([{ id: ID, display_name: "Acme", type: "recycle", deleted_time: "2026-10-01T10:00:00+05:30" }], { more_records: true })))
  const result = (await conn.execute("accounts.deleted", { type: "permanent", pageSize: 10 })) as Page
  assert.equal(calls[0]!.url.searchParams.get("type"), "permanent")
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "10")
  assert.equal(result.nextCursor, "2")
})

test("tags are sent as name objects in the body, with over_write only when asked", async () => {
  const { conn, calls } = h(() => json(saved))
  await conn.execute("leads.tags.add", { id: ID, tags: ["vip", "2026"] })
  await conn.execute("leads.tags.add", { id: ID, tags: ["only"], overwrite: true })
  await conn.execute("leads.tags.remove", { id: ID, tags: ["vip"] })
  assert.deepEqual(calls[0]!.body, { tags: [{ name: "vip" }, { name: "2026" }] })
  assert.deepEqual(calls[1]!.body, { tags: [{ name: "only" }], over_write: true })
  assert.deepEqual(calls[2]!.body, { tags: [{ name: "vip" }] })
})

test("notes.list asks for the note fields by default and takes a list of its own", async () => {
  const { conn, calls } = h(() => json(page([{ id: NOTE, Note_Title: "t", Note_Content: "c" }])))
  await conn.execute("leads.notes.list", { id: ID })
  assert.equal(calls[0]!.url.searchParams.get("fields"), "id,Note_Title,Note_Content,Owner,Created_Time,Modified_Time")
  await conn.execute("leads.notes.list", { id: ID, fields: ["Note_Content"] })
  assert.equal(calls[1]!.url.searchParams.get("fields"), "Note_Content")
})

test("converting a lead sends Zoho's conversion body, the deal needs its four fields, and the lead id is in the path", async () => {
  const { conn, calls } = h(() => json({ data: [{ code: "SUCCESS", status: "success", message: "converted", details: { Contacts: { id: "1" }, Accounts: { id: "2" }, Deals: { id: "3" } } }] }))
  await conn.execute("leads.convert", { id: ID, accountId: "4150868000009999999", deal: { Deal_Name: "Acme rollout", Closing_Date: "2026-12-31", Pipeline: "Standard", Stage: "Qualification" }, notifyLeadOwner: true, carryOverTags: true })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, `/crm/v8/Leads/${ID}/actions/convert`)
  assert.deepEqual(calls[0]!.body, { data: [{ Accounts: { id: "4150868000009999999" }, Deals: { Deal_Name: "Acme rollout", Closing_Date: "2026-12-31", Pipeline: "Standard", Stage: "Qualification" }, notify_lead_owner: true, carry_over_tags: true }] })
  const bad = h(() => json(saved))
  for (const deal of [{ Deal_Name: "x" }, { Deal_Name: "x", Closing_Date: "31/12/2026", Pipeline: "p", Stage: "s" }]) {
    await assert.rejects(() => bad.conn.execute("leads.convert", { id: ID, deal } as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(bad.calls.length, 0)
})

test("a lead that is already converted fails the call", async () => {
  const { conn } = h(() => json({ data: [{ code: "ID_ALREADY_CONVERTED", status: "error", message: "free text", details: {} }] }, 400))
  await assert.rejects(() => conn.execute("leads.convert", { id: ID }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})
