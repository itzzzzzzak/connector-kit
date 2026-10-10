import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { defineConnector } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const wrapped = defineConnector({
  name: "wrap",
  baseUrl: "https://api.wrap.dev/v1",
  auth: { type: "bearer" },
  actions: {
    "things.create": {
      description: "Create a thing; the API wants the fields wrapped in a data envelope.",
      method: "POST",
      path: "/things/{parent}",
      input: z.object({ parent: z.string(), name: z.string() }),
      output: z.object({ id: z.string() }),
      effect: "write",
      buildBody: (input) => ({ data: input }),
    },
    "things.plain": { description: "A write with no envelope at all.", method: "POST", path: "/plain", input: z.object({ name: z.string() }), output: z.object({ id: z.string() }), effect: "write" },
  },
})

test("buildBody shapes the body, and path parameters are already removed from it", async () => {
  const { conn, calls } = harness(wrapped, () => json({ id: "1" }, 201))
  await conn.execute("things.create", { parent: "p1", name: "n" })
  assert.deepEqual(calls[0]!.body, { data: { name: "n" } })
  assert.equal(calls[0]!.url.pathname, "/v1/things/p1")
})

test("without buildBody the input is sent as the body, unchanged", async () => {
  const { conn, calls } = harness(wrapped, () => json({ id: "1" }, 201))
  await conn.execute("things.plain", { name: "n" })
  assert.deepEqual(calls[0]!.body, { name: "n" })
})

// ---------------------------------------------------------------- buildQuery and optional page size

import { bodyCursorPagination } from "./index.js"

const querying = defineConnector({
  name: "query",
  baseUrl: "https://api.query.dev/v0",
  auth: { type: "bearer" },
  actions: {
    "rows.list": {
      description: "List rows with the provider's bracket-style query conventions.",
      method: "GET",
      path: "/rows/{table}",
      input: z.object({ table: z.string(), fields: z.array(z.string()).optional(), sort_field: z.string().optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "rows", cursorPath: ["offset"], cursorParam: "offset", pageSizeParam: "pageSize" }),
      buildQuery: ({ fields, sort_field, ...rest }) => ({
        ...rest,
        ...(fields !== undefined && { "fields[]": fields }),
        ...(sort_field !== undefined && { "sort[0][field]": sort_field, "sort[0][direction]": "asc" }),
      }),
    },
    "meta.list": {
      description: "A paginated endpoint that has no page-size parameter at all.",
      method: "GET",
      path: "/meta",
      input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "items", cursorPath: ["offset"], cursorParam: "offset", pageSizeParam: null }),
    },
    "plain.get": {
      description: "A non-paginated GET using buildQuery too.",
      method: "GET",
      path: "/plain",
      input: z.object({ tags: z.array(z.string()).optional() }),
      output: z.object({ ok: z.boolean() }),
      effect: "read",
      buildQuery: ({ tags }) => (tags === undefined ? {} : { "tags[]": tags }),
    },
  },
})

test("buildQuery turns inputs into the provider's bracket conventions; the table stays in the path", async () => {
  const { conn, calls } = harness(querying, () => json({ rows: [] }))
  await conn.execute("rows.list", { table: "Tasks", fields: ["Name", "Status"], sort_field: "Name" })
  const q = calls[0]!.url.searchParams
  assert.deepEqual(q.getAll("fields[]"), ["Name", "Status"])
  assert.equal(q.get("sort[0][field]"), "Name")
  assert.equal(q.get("sort[0][direction]"), "asc")
  assert.equal(q.get("pageSize"), "30")
  assert.equal(calls[0]!.url.pathname, "/v0/rows/Tasks")
})

test("buildQuery runs on every page, so the filters survive pagination", async () => {
  const { kit, conn, calls } = harness(querying, (c) => json(c.url.searchParams.has("offset") ? { rows: [{ id: "2" }] } : { rows: [{ id: "1" }], offset: "O2" }))
  const ids: string[] = []
  for await (const r of kit.paginate(conn, "rows.list", { table: "T", fields: ["A"] })) ids.push(r.id)
  assert.deepEqual(ids, ["1", "2"])
  assert.deepEqual(calls[1]!.url.searchParams.getAll("fields[]"), ["A"])
  assert.equal(calls[1]!.url.searchParams.get("offset"), "O2")
})

test("a paginated endpoint with no page-size parameter sends none, and still pages", async () => {
  const { conn, calls } = harness(querying, () => json({ items: [{ id: "1" }], offset: "NEXT" }))
  const page = await conn.execute("meta.list", { pageSize: 50 })
  assert.equal(page.nextCursor, "NEXT")
  assert.equal(calls[0]!.url.search, "")
})

test("buildQuery also applies to non-paginated GETs", async () => {
  const { conn, calls } = harness(querying, () => json({ ok: true }))
  await conn.execute("plain.get", { tags: ["a", "b"] })
  assert.deepEqual(calls[0]!.url.searchParams.getAll("tags[]"), ["a", "b"])
})
