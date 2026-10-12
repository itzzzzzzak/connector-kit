import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { bodyCursorPagination, createConnectorKit, defineConnector, checkConnector, memoryTokenStore } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

// ---------------------------------------------------------------- the cursor and page size travel in a POST body (Notion search)

const notes = defineConnector({
  name: "notes",
  baseUrl: "https://api.notes.test/v1",
  auth: { type: "bearer" },
  actions: {
    "pages.search": {
      description: "Search pages by title. The cursor and page size go in the JSON body.",
      method: "POST",
      path: "/search",
      input: z.object({ query: z.string().optional(), filter: z.object({ value: z.string() }).optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "results", cursorPath: ["next_cursor"], cursorParam: "start_cursor", pageSizeParam: "page_size", defaultPageSize: 20, maxPageSize: 100, cursorIn: "body" }),
    },
  },
})

test("body paging: the first page sends the filters and a page size in the body, and nothing in the URL", async () => {
  const { conn, calls } = harness(notes, () => json({ results: [{ id: "a" }], next_cursor: "c2", has_more: true }))
  const page = (await conn.execute("pages.search", { query: "roadmap", filter: { value: "page" } })) as { items: unknown[]; nextCursor: string | null }
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.search, "")
  assert.deepEqual(calls[0]!.body, { query: "roadmap", filter: { value: "page" }, page_size: 20 })
  assert.equal(page.nextCursor, "c2")
})

test("body paging: the next page sends the cursor in the body and keeps the filters", async () => {
  const { conn, calls } = harness(notes, () => json({ results: [{ id: "b" }], next_cursor: null, has_more: false }))
  const page = (await conn.execute("pages.search", { query: "roadmap", cursor: "c2", pageSize: 5 })) as { items: unknown[]; nextCursor: string | null }
  assert.deepEqual(calls[0]!.body, { query: "roadmap", page_size: 5, start_cursor: "c2" })
  assert.equal(calls[0]!.url.search, "")
  assert.deepEqual(page, { items: [{ id: "b" }], nextCursor: null })
})

test("body paging: the page size is clamped, and a non-string cursor is refused before anything is sent", async () => {
  const { conn, calls } = harness(notes, () => json({ results: [], next_cursor: null }))
  await conn.execute("pages.search", { pageSize: 5000 })
  assert.equal((calls[0]!.body as { page_size: number }).page_size, 100)
  await assert.rejects(() => conn.execute("pages.search", { cursor: 7 as never }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 1)
})

test("body paging: a POST that pages through its body passes the conformance check", () => {
  assert.deepEqual(checkConnector(notes, { requireMeta: false }), [])
})

// ---------------------------------------------------------------- the OAuth token request can be JSON (Notion)

const hub = defineConnector({
  name: "hub",
  baseUrl: "https://api.hub.test/v1",
  auth: { type: "oauth2", authorizeUrl: "https://hub.test/authorize", tokenUrl: "https://hub.test/token", clientAuth: "basic", tokenRequestFormat: "json", pkce: false },
  actions: { "me.get": { description: "Get the connected user.", method: "GET", path: "/me", input: z.object({}), output: z.object({ id: z.string() }), effect: "read" } },
})

test("a connector can ask for a JSON token request, with the client sent as HTTP Basic", async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const kit = createConnectorKit({
    retry: { maxRetries: 0 },
    tokenStore: memoryTokenStore(),
    oauth: { hub: { clientId: "id_1", clientSecret: "secret_2", redirectUri: "https://app.test/cb" } },
    fetch: (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return String(url).startsWith("https://hub.test/token") ? json({ access_token: "at_1", token_type: "bearer" }) : json({ id: "u1" })
    }) as typeof fetch,
  })
  const { state } = await kit.startAuth(hub, { connectionId: "u" })
  await kit.finishAuth(hub, { code: "code_9", state })
  const token = seen.find((c) => c.url === "https://hub.test/token")!
  const headers = new Headers(token.init.headers)
  assert.equal(headers.get("content-type"), "application/json")
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("id_1:secret_2").toString("base64")}`)
  const body = JSON.parse(String(token.init.body)) as Record<string, string>
  assert.equal(body.grant_type, "authorization_code")
  assert.equal(body.code, "code_9")
  assert.equal(body.client_secret, undefined, "the secret is in the Basic header, not the body")
  await kit.connect(hub, { connectionId: "u" }).execute("me.get", {})
})
