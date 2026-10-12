import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit, memoryTokenStore } from "../../index.js"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import notion from "./index.js"

const ID = "59833787-2cf9-4fdf-8782-e53db20768a5"
const list = (results: unknown[], next: string | null = null) => ({ object: "list", results, next_cursor: next, has_more: next !== null })
const user = { object: "user", id: ID, type: "person", name: "Ada", person: { email: "ada@acme.dev" } }
const page = { object: "page", id: ID, created_time: "2026-10-01T00:00:00.000Z", last_edited_time: "2026-10-02T00:00:00.000Z", in_trash: false, url: "https://notion.so/x", parent: { type: "page_id", page_id: ID }, properties: { title: { id: "title", type: "title", title: [] } } }
const block = { object: "block", id: ID, type: "paragraph", has_children: false, paragraph: { rich_text: [{ type: "text", plain_text: "Hello", text: { content: "Hello" } }] } }
const dataSource = { object: "data_source", id: ID, title: [], properties: { Name: { id: "title", type: "title", title: {} } } }
const comment = { object: "comment", id: ID, discussion_id: ID, rich_text: [] }
const md = { object: "page_markdown", id: ID, markdown: "# Hi", truncated: false }

const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; badInput?: Record<string, unknown> }> = [
  { action: "users.list", input: {}, ok: list([user]), badInput: { pageSize: "ten" } },
  { action: "users.get", input: { user_id: ID }, ok: user, badInput: { user_id: "" } },
  { action: "users.getMe", input: {}, ok: user },
  { action: "search", input: { query: "roadmap" }, ok: list([page]), badInput: { filter: { property: "object", value: "workspace" } } },
  { action: "pages.get", input: { page_id: ID }, ok: page, badInput: { page_id: "" } },
  { action: "pages.create", input: { parent: { page_id: ID }, properties: { title: [] } }, ok: page, badInput: { parent: { folder: "x" }, properties: {} } },
  { action: "pages.update", input: { page_id: ID, in_trash: true }, ok: page, badInput: { page_id: ID, in_trash: "yes" } },
  { action: "pages.move", input: { page_id: ID, parent: { type: "page_id", page_id: ID } }, ok: page, badInput: { page_id: ID, parent: { type: "moon" } } },
  { action: "pages.getProperty", input: { page_id: ID, property_id: "title" }, ok: list([{ object: "property_item", id: "title" }]), badInput: { page_id: ID, property_id: "" } },
  { action: "pages.getMarkdown", input: { page_id: ID }, ok: md, badInput: { page_id: "" } },
  { action: "pages.updateMarkdown", input: { page_id: ID, type: "replace_content", replace_content: { new_str: "# Hi" } }, ok: md, badInput: { page_id: ID, type: "erase" } },
  { action: "blocks.get", input: { block_id: ID }, ok: block, badInput: { block_id: "" } },
  { action: "blocks.listChildren", input: { block_id: ID }, ok: list([block]), badInput: { block_id: "" } },
  { action: "blocks.appendChildren", input: { block_id: ID, children: [block] }, ok: list([block]), badInput: { block_id: ID, children: "text" } },
  { action: "blocks.update", input: { block_id: ID, content: { to_do: { checked: true } } }, ok: block, badInput: { block_id: ID, content: "x" } },
  { action: "blocks.delete", input: { block_id: ID }, ok: block, badInput: { block_id: "" } },
  { action: "comments.list", input: { block_id: ID }, ok: list([comment]), badInput: { block_id: "" } },
  { action: "comments.create", input: { parent: { page_id: ID }, rich_text: [{ text: { content: "hi" } }] }, ok: comment, badInput: { parent: { page_id: ID }, rich_text: "hi" } },
  { action: "databases.get", input: { database_id: ID }, ok: { object: "database", id: ID, data_sources: [{ id: ID, name: "Tasks" }] }, badInput: { database_id: "" } },
  { action: "dataSources.get", input: { data_source_id: ID }, ok: dataSource, badInput: { data_source_id: "" } },
  { action: "dataSources.query", input: { data_source_id: ID }, ok: list([page]), badInput: { data_source_id: ID, sorts: "asc" } },
  { action: "dataSources.create", input: { parent: { page_id: ID }, properties: { Name: { title: {} } } }, ok: dataSource, badInput: { parent: {}, properties: {} } },
  { action: "dataSources.update", input: { data_source_id: ID, title: [] }, ok: dataSource, badInput: { data_source_id: ID, title: "x" } },
  { action: "dataSources.listTemplates", input: { data_source_id: ID }, ok: { object: "list", templates: [{ id: ID, name: "Bug", is_default: true }], next_cursor: null, has_more: false }, badInput: { data_source_id: "" } },
]
for (const c of cases) standardTests(notion, { action: c.action, input: c.input, ok: c.ok, ...(c.badInput && { badInput: c.badInput }) })

const h = (respond: Parameters<typeof harness>[1]) => harness(notion, respond, { credentials: { token: "secret_abc" } })

test("every call carries the bearer token and the pinned Notion-Version", async () => {
  const { conn, calls } = h(() => json(page))
  await conn.execute("pages.get", { page_id: ID })
  assert.equal(calls[0]!.url.toString(), `https://api.notion.com/v1/pages/${ID}`)
  assert.equal(calls[0]!.header("authorization"), "Bearer secret_abc")
  assert.match(calls[0]!.header("notion-version")!, /^\d{4}-\d{2}-\d{2}$/)
})

test("search sends its filter, sort and page size in the body, and pages by next_cursor", async () => {
  const { conn, calls } = h((call) => json((call.body as { start_cursor?: string }).start_cursor ? list([page]) : list([page], "cur_2")))
  const first = (await conn.execute("search", { query: "roadmap", filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, pageSize: 10 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.search, "")
  assert.deepEqual(calls[0]!.body, { query: "roadmap", filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 10 })
  assert.equal(first.nextCursor, "cur_2")
  const second = (await conn.execute("search", { query: "roadmap", cursor: "cur_2" })) as { nextCursor: string | null }
  assert.equal((calls[1]!.body as { start_cursor: string }).start_cursor, "cur_2")
  assert.equal(second.nextCursor, null)
})

test("a data source query sends the filter in the body and filter_properties in the URL", async () => {
  const { conn, calls } = h(() => json(list([page])))
  await conn.execute("dataSources.query", { data_source_id: ID, filter: { property: "Status", status: { equals: "Done" } }, sorts: [{ property: "Due", direction: "ascending" }], filter_properties: ["title", "abc"], pageSize: 50 })
  assert.equal(calls[0]!.url.pathname, `/v1/data_sources/${ID}/query`)
  assert.deepEqual(calls[0]!.url.searchParams.getAll("filter_properties"), ["title", "abc"])
  assert.deepEqual(calls[0]!.body, { filter: { property: "Status", status: { equals: "Done" } }, sorts: [{ property: "Due", direction: "ascending" }], page_size: 50 })
})

test("a query is a read: it is retried after a 5xx, unlike a write", async () => {
  let n = 0
  const retry = { maxRetries: 2, sleep: async () => {}, random: () => 0 }
  const { conn, calls } = harness(notion, () => (++n === 1 ? json({}, 503) : json(list([page]))), { credentials: { token: "t" }, retry })
  await conn.execute("dataSources.query", { data_source_id: ID })
  assert.equal(calls.length, 2)
})

test("list endpoints take the cursor and page size in the query string", async () => {
  const { conn, calls } = h(() => json(list([block], "next_1")))
  const page1 = (await conn.execute("blocks.listChildren", { block_id: ID, pageSize: 100 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.searchParams.get("page_size"), "100")
  assert.equal(page1.nextCursor, "next_1")
  await conn.execute("blocks.listChildren", { block_id: ID, cursor: "next_1" })
  assert.equal(calls[1]!.url.searchParams.get("start_cursor"), "next_1")
})

test("a block keeps its text content, which lives under a key named after its type", async () => {
  const { conn } = h(() => json(list([block])))
  const result = (await conn.execute("blocks.listChildren", { block_id: ID })) as { items: Array<{ paragraph?: { rich_text: Array<{ plain_text: string }> } }> }
  assert.equal(result.items[0]!.paragraph!.rich_text[0]!.plain_text, "Hello")
})

test("creating a page sends the parent, properties and child blocks as JSON", async () => {
  const { conn, calls } = h(() => json(page))
  await conn.execute("pages.create", { parent: { data_source_id: ID }, properties: { Name: { title: [{ text: { content: "Roadmap" } }] } }, children: [block] })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.header("content-type"), "application/json")
  assert.deepEqual((calls[0]!.body as { parent: unknown }).parent, { data_source_id: ID })
  assert.equal(((calls[0]!.body as { children: unknown[] }).children).length, 1)
})

test("updating a block sends the type key at the top of the body, and trashing a block is destructive", async () => {
  const { conn, calls } = h(() => json(block))
  await conn.execute("blocks.update", { block_id: ID, content: { to_do: { checked: true } } })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.deepEqual(calls[0]!.body, { to_do: { checked: true } })
  assert.equal(notion.actions["blocks.delete"]!.effect, "destructive")
  await conn.execute("blocks.delete", { block_id: ID })
  assert.equal(calls[1]!.init.method, "DELETE")
  assert.equal(calls[1]!.init.body, undefined)
})

test("a comment names a page or a discussion, never both and never neither", async () => {
  const { conn, calls } = h(() => json(comment))
  for (const input of [{ rich_text: [] }, { parent: { page_id: ID }, discussion_id: ID, rich_text: [] }]) {
    await assert.rejects(() => conn.execute("comments.create", input as never), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  }
  assert.equal(calls.length, 0)
  await conn.execute("comments.create", { discussion_id: ID, rich_text: [{ text: { content: "ok" } }] })
  assert.equal(calls.length, 1)
})

test("template lists are read from `templates`, with `results` as a fallback", async () => {
  const a = h(() => json({ templates: [{ id: ID, name: "Bug" }], next_cursor: null }))
  assert.equal(((await a.conn.execute("dataSources.listTemplates", { data_source_id: ID })) as { items: unknown[] }).items.length, 1)
  const b = h(() => json({ results: [{ id: ID }], next_cursor: null }))
  assert.equal(((await b.conn.execute("dataSources.listTemplates", { data_source_id: ID })) as { items: unknown[] }).items.length, 1)
})

test("a path value cannot escape its segment", async () => {
  const { conn, calls } = h(() => json(page))
  await assert.rejects(() => conn.execute("pages.get", { page_id: ".." }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  assert.equal(calls.length, 0)
})

test("the OAuth flow sends no scope and no PKCE, asks for owner=user, and exchanges the code with JSON and HTTP Basic", async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const kit = createConnectorKit({
    retry: { maxRetries: 0 },
    tokenStore: memoryTokenStore(),
    oauth: { notion: { clientId: "client_1", clientSecret: "secret_2", redirectUri: "https://app.test/cb" } },
    fetch: (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return String(url).endsWith("/oauth/token") ? json({ access_token: "ntn_1", token_type: "bearer", bot_id: ID, workspace_id: ID }) : json(user)
    }) as typeof fetch,
  })
  const { url, state } = await kit.startAuth(notion, { connectionId: "u" })
  const authorize = new URL(url)
  assert.equal(authorize.origin + authorize.pathname, "https://api.notion.com/v1/oauth/authorize")
  assert.equal(authorize.searchParams.get("owner"), "user")
  assert.equal(authorize.searchParams.has("code_challenge"), false)
  assert.equal(authorize.searchParams.has("scope"), false)
  await kit.finishAuth(notion, { code: "code_9", state })
  const token = seen.find((c) => c.url.endsWith("/oauth/token"))!
  assert.equal(new Headers(token.init.headers).get("content-type"), "application/json")
  assert.equal(new Headers(token.init.headers).get("authorization"), `Basic ${Buffer.from("client_1:secret_2").toString("base64")}`)
  assert.equal((JSON.parse(String(token.init.body)) as { code: string }).code, "code_9")
  await kit.connect(notion, { connectionId: "u" }).execute("users.getMe", {})
  assert.equal(new Headers(seen.at(-1)!.init.headers).get("authorization"), "Bearer ntn_1")
})
