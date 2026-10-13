import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import confluence, { toStorage } from "./index.js"

const connect = { variables: { site: "acme" }, credentials: { token: "me@acme.dev:APITOKEN" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(confluence, respond, connect)
const spaceId = "65538"
const pageId = "98765"
const space = { id: spaceId, key: "ENG", name: "Engineering", type: "global", status: "current" }
const page = { id: pageId, title: "Onboarding", status: "current", spaceId, parentId: null, version: { number: 3, createdAt: "2026-10-01T00:00:00Z" } }
const std = (c: Parameters<typeof standardTests>[1]) => standardTests(confluence, { ...c, connect })

std({ action: "spaces.list", input: {}, ok: { results: [space], _links: {} }, badInput: { type: "secret" } })
std({ action: "space.get", input: { spaceId }, ok: space, badInput: { spaceId: "ENG" } })
std({ action: "pages.list", input: {}, ok: { results: [page], _links: {} }, badInput: { sort: "random" } })
std({ action: "page.get", input: { pageId }, ok: page, badInput: { pageId: "../x" } })
std({ action: "pageChildren.list", input: { pageId }, ok: { results: [{ id: "2", title: "Child" }], _links: {} }, badInput: { pageId: "" } })
std({ action: "comments.list", input: { pageId }, ok: { results: [{ id: "7", pageId, body: { storage: { value: "<p>hi</p>" } } }], _links: {} }, badInput: { pageId: "x" } })
std({ action: "search.cql", input: { cql: "type = page" }, ok: { results: [{ title: "Onboarding", content: { id: pageId, type: "page" } }], start: 0, limit: 25, size: 1, totalSize: 1 }, badInput: { cql: "" } })
std({ action: "page.create", input: { spaceId, title: "New", text: "Hello" }, ok: page, badInput: { spaceId, title: "New" } })
std({ action: "page.update", input: { pageId, title: "Onboarding", currentVersion: 3, text: "Hello" }, ok: page, badInput: { pageId, title: "Onboarding", currentVersion: 0, text: "Hello" } })
std({ action: "page.delete", input: { pageId }, ok: null, badInput: { pageId: "" } })
std({ action: "comment.create", input: { pageId, text: "Looks good" }, ok: { id: "9", pageId }, badInput: { pageId, text: "" } })

test("the site variable fills the host and the paths sit under /wiki", async () => {
  const { conn, calls } = h(() => json({ results: [], _links: {} }))
  await conn.execute("spaces.list", { keys: ["ENG", "HR"] })
  assert.equal(calls[0]!.url.host, "acme.atlassian.net")
  assert.equal(calls[0]!.url.pathname, "/wiki/api/v2/spaces")
  assert.equal(calls[0]!.url.searchParams.get("keys"), "ENG,HR")
})

test("plain text becomes escaped storage-format paragraphs", () => {
  assert.equal(toStorage("Hi <b>there</b> & you\nline two\n\nNext"), "<p>Hi &lt;b&gt;there&lt;/b&gt; &amp; you<br />line two</p><p>Next</p>")
})

test("creating a page sends storage format, as current unless it is a draft", async () => {
  const { conn, calls } = h(() => json(page))
  await conn.execute("page.create", { spaceId, title: "New", parentId: "11", text: "Hello" })
  await conn.execute("page.create", { spaceId, title: "Raw", draft: true, storage: "<h1>Hi</h1>" })
  assert.deepEqual(calls[0]!.body, { spaceId, status: "current", title: "New", parentId: "11", body: { representation: "storage", value: "<p>Hello</p>" } })
  assert.deepEqual(calls[1]!.body, { spaceId, status: "draft", title: "Raw", body: { representation: "storage", value: "<h1>Hi</h1>" } })
})

test("a body must be given as exactly one of text or storage", async () => {
  const { conn, calls } = h(() => json(page))
  await assert.rejects(() => conn.execute("page.create", { spaceId, title: "x", text: "a", storage: "<p>a</p>" }), /exactly one/)
  assert.equal(calls.length, 0)
})

test("an update sends the NEXT version number and the id in the body", async () => {
  const { conn, calls } = h(() => json(page))
  await conn.execute("page.update", { pageId, title: "Onboarding", currentVersion: 3, text: "New text", versionMessage: "fix typo" })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.deepEqual(calls[0]!.body, { id: pageId, status: "current", title: "Onboarding", body: { representation: "storage", value: "<p>New text</p>" }, version: { number: 4, message: "fix typo" } })
})

test("deleting trashes the page; purge is only sent when asked for", async () => {
  const { conn, calls } = h(() => new Response(null, { status: 204 }))
  await conn.execute("page.delete", { pageId })
  await conn.execute("page.delete", { pageId, purge: true })
  assert.equal(calls[0]!.url.search, "")
  assert.equal(calls[1]!.url.searchParams.get("purge"), "true")
  assert.equal(confluence.actions["page.delete"].effect, "destructive")
})

test("a v2 list follows its relative next link and stops without one", async () => {
  const nextLink = "/wiki/api/v2/pages?cursor=abc&limit=1"
  const more = h(() => json({ results: [page], _links: { next: nextLink } }))
  const result = (await more.conn.execute("pages.list", { pageSize: 1 })) as { nextCursor: string | null }
  assert.equal(more.calls[0]!.url.searchParams.get("limit"), "1")
  assert.equal(result.nextCursor, nextLink)
  const last = h(() => json({ results: [page], _links: {} }))
  assert.equal(((await last.conn.execute("pages.list", {})) as { nextCursor: string | null }).nextCursor, null)
})

test("search pages by start offset using totalSize", async () => {
  const { conn, calls } = h(() => json({ results: [{ title: "a" }, { title: "b" }], start: 0, limit: 2, size: 2, totalSize: 5 }))
  const result = (await conn.execute("search.cql", { cql: 'text ~ "x"', pageSize: 2 })) as { nextCursor: string | null }
  assert.equal(calls[0]!.url.pathname, "/wiki/rest/api/search")
  assert.equal(calls[0]!.url.searchParams.get("cql"), 'text ~ "x"')
  assert.equal(result.nextCursor, "2")
})
