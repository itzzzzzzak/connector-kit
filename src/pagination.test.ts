import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { bodyCursorPagination, bodyLinkPagination, ConnectorKitError, createConnectorKit, defineConnector, linkHeaderPagination } from "./index.js"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const widgets = defineConnector({
  name: "w",
  baseUrl: "https://api.w.test",
  auth: { type: "bearer" },
  // a provider that reports failure inside HTTP 200
  detectError: (body) =>
    (body as { ok?: boolean })?.ok === false ? new ConnectorKitError("forbidden", `no: ${(body as { error: string }).error}`, { retryable: false }) : undefined,
  actions: {
    "things.list": {
      description: "List things.",
      method: "GET",
      path: "/things.list",
      input: z.object({ kind: z.string().optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "things", cursorPath: ["meta", "next"] }),
    },
    "thing.get": { description: "Get one.", method: "GET", path: "/thing.get", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), effect: "read" },
  },
})

function setup(handler: (url: URL) => Response, retry = { maxRetries: 0 } as Record<string, unknown>) {
  const calls: URL[] = []
  const kit = createConnectorKit({ retry, fetch: (async (input: URL | string) => (calls.push(new URL(String(input))), handler(new URL(String(input))))) as typeof fetch })
  return { kit, calls, conn: kit.connect(widgets, { connectionId: "c", credentials: { token: "t" } }) }
}

// ----------------------------------------------------------------- bodyCursorPagination (unit)

const strategy = bodyCursorPagination({ itemsKey: "things", cursorPath: ["meta", "next"] })

test("body cursor: finds the list and the cursor inside the body", () => {
  const body = { things: [{ id: "1" }], meta: { next: "abc" } }
  assert.deepEqual(strategy.items!(body), [{ id: "1" }])
  assert.equal(strategy.nextCursor({ headers: new Headers(), body }), "abc")
})

test("body cursor: empty, missing, null or non-string cursors all mean 'no more pages'", () => {
  for (const body of [{ meta: { next: "" } }, { meta: {} }, { meta: { next: null } }, { meta: { next: 5 } }, {}, null, "text", undefined]) {
    assert.equal(strategy.nextCursor({ headers: new Headers(), body }), null, JSON.stringify(body))
  }
})

test("body cursor: applyCursor adds one param, keeps the rest, and does not mutate the input URL", () => {
  const first = new URL("https://api.w.test/things.list?kind=a&limit=30")
  const next = strategy.applyCursor(first, "tok=en&x=1")
  assert.equal(next.searchParams.get("cursor"), "tok=en&x=1")
  assert.equal(next.searchParams.get("kind"), "a")
  assert.equal(next.searchParams.get("limit"), "30")
  assert.equal([...next.searchParams.keys()].length, 3, "a hostile cursor must not smuggle extra parameters")
  assert.equal(first.searchParams.has("cursor"), false)
})

test("link header strategy still replaces the whole URL (GitHub behavior unchanged)", () => {
  const link = linkHeaderPagination()
  assert.equal(link.applyCursor(new URL("https://api.w.test/a"), "https://api.w.test/b?page=2").toString(), "https://api.w.test/b?page=2")
})

// ----------------------------------------------------------------- through the kit

test("first page: list taken from the body, default page size, filters kept", async () => {
  const { conn, calls } = setup(() => json({ things: [{ id: "1" }, { id: "2" }], meta: { next: "CUR2" } }))
  const page = await conn.execute("things.list", { kind: "x" })
  assert.deepEqual(page, { items: [{ id: "1" }, { id: "2" }], nextCursor: "CUR2" })
  assert.equal(calls[0]!.searchParams.get("limit"), "30")
  assert.equal(calls[0]!.searchParams.get("kind"), "x")
  assert.equal(calls[0]!.searchParams.has("cursor"), false)
})

test("next page: the cursor is sent back WITH the same filters and page size", async () => {
  const { conn, calls } = setup(() => json({ things: [], meta: { next: "" } }))
  const page = await conn.execute("things.list", { kind: "x", cursor: "CUR2", pageSize: 50 })
  assert.equal(page.nextCursor, null)
  assert.equal(calls[0]!.searchParams.get("cursor"), "CUR2")
  assert.equal(calls[0]!.searchParams.get("kind"), "x")
  assert.equal(calls[0]!.searchParams.get("limit"), "50")
})

test("page size is clamped to the strategy's maximum (200)", async () => {
  const { conn, calls } = setup(() => json({ things: [] }))
  await conn.execute("things.list", { pageSize: 99_999 })
  assert.equal(calls[0]!.searchParams.get("limit"), "200")
})

test("kit.paginate follows body cursors across pages until the cursor is empty", async () => {
  const { kit, conn, calls } = setup((url) => {
    const cursor = url.searchParams.get("cursor")
    if (cursor === null) return json({ things: [{ id: "1" }, { id: "2" }], meta: { next: "P2" } })
    if (cursor === "P2") return json({ things: [{ id: "3" }], meta: { next: "P3" } })
    return json({ things: [{ id: "4" }], meta: { next: "" } })
  })
  const ids: string[] = []
  for await (const thing of kit.paginate(conn, "things.list", { kind: "x" })) ids.push(thing.id)
  assert.deepEqual(ids, ["1", "2", "3", "4"])
  assert.equal(calls.length, 3)
  assert.ok(calls.every((c) => c.searchParams.get("kind") === "x"), "filters must survive every page")
})

test("a response whose list is missing is an upstream_error, not a crash", async () => {
  const { conn } = setup(() => json({ unexpected: true }))
  await assert.rejects(() => conn.execute("things.list", {}), (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error")
})

// ----------------------------------------------------------------- detectError (a 200 that is really a failure)

test("detectError: a 200 carrying an error becomes the connector's error", async () => {
  const { conn } = setup(() => json({ ok: false, error: "nope" }))
  await assert.rejects(() => conn.execute("thing.get", { id: "1" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "forbidden" && e.message === "no: nope")
})

test("detectError also guards paginated actions", async () => {
  const { conn } = setup(() => json({ ok: false, error: "nope" }))
  await assert.rejects(() => conn.execute("things.list", {}), (e: unknown) => e instanceof ConnectorKitError && e.code === "forbidden")
})

test("detectError: a healthy body passes through untouched", async () => {
  const { conn } = setup(() => json({ id: "1", ok: true }))
  assert.deepEqual(await conn.execute("thing.get", { id: "1" }), { id: "1" })
})

test("detectError is not consulted for non-2xx responses (those use the standard status mapping)", async () => {
  const { conn } = setup(() => json({ ok: false, error: "nope" }, 404))
  await assert.rejects(() => conn.execute("thing.get", { id: "1" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found")
})

test("an error from detectError takes part in retries like any other (retryable read is retried)", async () => {
  const flaky = defineConnector({
    ...widgets,
    detectError: (body) => ((body as { ok?: boolean }).ok === false ? new ConnectorKitError("upstream_error", "blip", { retryable: true }) : undefined),
  })
  let n = 0
  const slept: number[] = []
  const kit = createConnectorKit({
    retry: { maxRetries: 2, sleep: async (ms: number) => void slept.push(ms), random: () => 0 },
    fetch: (async () => json(++n === 1 ? { ok: false } : { id: "1" })) as typeof fetch,
  })
  assert.deepEqual(await kit.connect(flaky, { connectionId: "c", credentials: { token: "t" } }).execute("thing.get", { id: "1" }), { id: "1" })
  assert.equal(n, 2)
  assert.equal(slept.length, 1)
})

// ----------------------------------------------------------------- bodyLinkPagination (next-page URL inside the body)

const linked = defineConnector({
  name: "linked",
  baseUrl: "https://api.linked.test/v2",
  auth: { type: "bearer" },
  actions: {
    "items.list": {
      description: "List items; the body carries the next page's full URL.",
      method: "GET",
      path: "/items",
      input: z.object({ name: z.string().optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.number() })),
      effect: "read",
      paginate: bodyLinkPagination({ itemsKey: "items", nextUrlPath: ["links", "pages", "next"], defaultPageSize: 20, maxPageSize: 200 }),
    },
  },
})

test("body link: the list is read from the body and the next-page URL becomes the cursor", async () => {
  const { kit, conn, calls } = setup2((url) =>
    url.searchParams.get("page") === "2" ? json({ items: [{ id: 3 }], links: { pages: { prev: "https://api.linked.test/v2/items?page=1" } } }) : json({ items: [{ id: 1 }, { id: 2 }], links: { pages: { next: "https://api.linked.test/v2/items?page=2&per_page=20", last: "x" } } }),
  )
  const ids: number[] = []
  for await (const i of kit.paginate(conn, "items.list", { name: "web" })) ids.push(i.id)
  assert.deepEqual(ids, [1, 2, 3])
  assert.equal(calls[0]!.searchParams.get("per_page"), "20")
  assert.equal(calls[0]!.searchParams.get("name"), "web")
  assert.equal(calls[1]!.toString(), "https://api.linked.test/v2/items?page=2&per_page=20")
})

test("body link: no next link means the end, and a next link pointing off-host is refused", async () => {
  const done = setup2(() => json({ items: [], links: {} }))
  assert.equal((await done.conn.execute("items.list", {})).nextCursor, null)
  const evil = setup2(() => json({ items: [{ id: 1 }], links: { pages: { next: "https://evil.example.net/steal?page=2" } } }))
  await assert.rejects(() => evil.conn.execute("items.list", {}), (e: unknown) => e instanceof ConnectorKitError && e.code === "invalid_input")
})

function setup2(handler: (url: URL) => Response) {
  const calls: URL[] = []
  const kit = createConnectorKit({ retry: { maxRetries: 0 }, fetch: (async (input: URL | string) => (calls.push(new URL(String(input))), handler(new URL(String(input))))) as typeof fetch })
  return { kit, calls, conn: kit.connect(linked, { connectionId: "c", credentials: { token: "t" } }) }
}
