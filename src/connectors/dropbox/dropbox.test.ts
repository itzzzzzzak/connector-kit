import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectorKitError } from "../../index.js"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import dropbox from "./index.js"

const sampleEntry = {
  ".tag": "file",
  id: "id:a4ayc_80_OEAAAAAAAAAXw",
  name: "report.pdf",
  path_lower: "/documents/report.pdf",
  path_display: "/Documents/report.pdf",
  client_modified: "2026-10-01T00:00:00Z",
  server_modified: "2026-10-01T00:00:00Z",
  rev: "a1c10ecd10d",
  size: 1024,
  is_downloadable: true,
  content_hash: "2a8d6f095d32011bb34134f6f3f0f3f023",
}

const sampleFolder = {
  ".tag": "folder",
  id: "id:a4ayc_80_OEAAAAAAAAAXz",
  name: "documents",
  path_lower: "/documents",
  path_display: "/Documents",
}

const sampleList = {
  entries: [sampleFolder, sampleEntry],
  cursor: "cur_12345",
  has_more: true,
}

const sampleListEnd = {
  entries: [sampleEntry],
  cursor: "cur_end",
  has_more: false,
}

const sampleSearch = {
  matches: [
    {
      match_type: { ".tag": "filename" },
      metadata: {
        ".tag": "metadata",
        metadata: sampleEntry,
      },
    },
  ],
  cursor: "search_cur_1",
  has_more: false,
}

const sampleDelete = {
  metadata: sampleEntry,
}

const sampleSharedLink = {
  ".tag": "file",
  url: "https://www.dropbox.com/s/sample/report.pdf?dl=0",
  id: "id:link_123",
  name: "report.pdf",
  path_lower: "/documents/report.pdf",
}

const sampleSharedLinksList = {
  links: [sampleSharedLink],
  has_more: false,
  cursor: "links_cur_1",
}

const cases: Array<{ action: string; input: Record<string, unknown>; ok: unknown; badInput?: Record<string, unknown> }> = [
  {
    action: "files.listFolder",
    input: { path: "/documents", limit: 50 },
    ok: sampleList,
    badInput: { path: 123 },
  },
  {
    action: "files.listFolderContinue",
    input: { cursor: "cur_12345" },
    ok: sampleListEnd,
    badInput: { cursor: "" },
  },
  {
    action: "files.getMetadata",
    input: { path: "/documents/report.pdf" },
    ok: sampleEntry,
    badInput: { path: "" },
  },
  {
    action: "files.search",
    input: { query: "report", options: { path: "/documents", max_results: 10 } },
    ok: sampleSearch,
    badInput: { query: "" },
  },
  {
    action: "files.searchContinue",
    input: { cursor: "search_cur_1" },
    ok: sampleSearch,
    badInput: { cursor: "" },
  },
  {
    action: "files.delete",
    input: { path: "/documents/report.pdf" },
    ok: sampleDelete,
    badInput: { path: "" },
  },
  {
    action: "sharing.createSharedLink",
    input: { path: "/documents/report.pdf", settings: { requested_visibility: "public" } },
    ok: sampleSharedLink,
    badInput: { path: "" },
  },
  {
    action: "sharing.listSharedLinks",
    input: { path: "/documents/report.pdf", direct_only: true },
    ok: sampleSharedLinksList,
    badInput: { direct_only: "yes" },
  },
]

for (const c of cases) {
  standardTests(dropbox, { action: c.action, input: c.input, ok: c.ok, ...(c.badInput && { badInput: c.badInput }) })
}

const h = (respond: Parameters<typeof harness>[1]) => harness(dropbox, respond, { credentials: { token: "dropbox-secret-token" } })

test("every call uses POST with JSON body and bearer authorization header", async () => {
  const { conn, calls } = h(() => json(sampleEntry))
  const result = await conn.execute("files.getMetadata", { path: "/documents/report.pdf" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.header("authorization"), "Bearer dropbox-secret-token")
  assert.equal(calls[0]!.header("content-type"), "application/json")
  assert.deepEqual(calls[0]!.body, { path: "/documents/report.pdf" })
  assert.deepEqual(result, sampleEntry)
})

test("listing a folder and continuing with cursor workflow", async () => {
  const { conn, calls } = h((call) => {
    if (call.url.pathname === "/2/files/list_folder") return json(sampleList)
    if (call.url.pathname === "/2/files/list_folder/continue") return json(sampleListEnd)
    return json({}, 404)
  })

  const page1 = (await conn.execute("files.listFolder", { path: "/documents" })) as typeof sampleList
  assert.equal(calls[0]!.url.pathname, "/2/files/list_folder")
  assert.deepEqual(calls[0]!.body, { path: "/documents" })
  assert.equal(page1.has_more, true)
  assert.equal(page1.cursor, "cur_12345")

  const page2 = (await conn.execute("files.listFolderContinue", { cursor: page1.cursor })) as typeof sampleListEnd
  assert.equal(calls[1]!.url.pathname, "/2/files/list_folder/continue")
  assert.deepEqual(calls[1]!.body, { cursor: "cur_12345" })
  assert.equal(page2.has_more, false)
})

test("Dropbox 409 path/not_found is mapped to not_found error", async () => {
  const notFoundBody = {
    error_summary: "path/not_found/..",
    error: {
      ".tag": "path",
      path: { ".tag": "not_found" },
    },
  }
  const { conn } = h(() => json(notFoundBody, 409))
  await assert.rejects(
    () => conn.execute("files.getMetadata", { path: "/does-not-exist.txt" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found",
  )
})

test("files.delete sends the path and is destructive (not retried on 5xx)", async () => {
  let count = 0
  const retry = { maxRetries: 2, sleep: async () => {}, random: () => 0 }
  const { conn, calls } = harness(dropbox, () => (++count === 1 ? json({}, 500) : json(sampleDelete)), {
    credentials: { token: "token" },
    retry,
  })

  await assert.rejects(
    () => conn.execute("files.delete", { path: "/trash/old.txt" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error",
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.body, { path: "/trash/old.txt" })
})

test("search sends query and options correctly in the JSON body", async () => {
  const { conn, calls } = h(() => json(sampleSearch))
  const result = await conn.execute("files.search", {
    query: "tax report",
    options: { path: "/finance", max_results: 25, filename_only: true },
  })
  assert.equal(calls[0]!.url.pathname, "/2/files/search_v2")
  assert.deepEqual(calls[0]!.body, {
    query: "tax report",
    options: { path: "/finance", max_results: 25, filename_only: true },
  })
  assert.deepEqual(result, sampleSearch)
})

test("sharing.createSharedLink sends settings and returns shared link details", async () => {
  const { conn, calls } = h(() => json(sampleSharedLink))
  const result = await conn.execute("sharing.createSharedLink", {
    path: "/documents/report.pdf",
    settings: { requested_visibility: "public", access: "viewer" },
  })
  assert.equal(calls[0]!.url.pathname, "/2/sharing/create_shared_link_with_settings")
  assert.deepEqual(calls[0]!.body, {
    path: "/documents/report.pdf",
    settings: { requested_visibility: "public", access: "viewer" },
  })
  assert.deepEqual(result, sampleSharedLink)
})

test("files.listFolder parses deleted entries without an id", async () => {
  const deletedEntry = { ".tag": "deleted", name: "old.txt", path_lower: "/old.txt" }
  const listWithDeleted = {
    entries: [deletedEntry],
    cursor: "cur_del",
    has_more: false,
  }
  const { conn } = h(() => json(listWithDeleted))
  const result = (await conn.execute("files.listFolder", { path: "/documents", include_deleted: true })) as typeof listWithDeleted
  assert.deepEqual(result.entries[0], deletedEntry)
})

test("files.delete on a missing path (409 path_lookup/not_found) is mapped to not_found", async () => {
  const notFoundBody = {
    error_summary: "path_lookup/not_found/..",
    error: {
      ".tag": "path_lookup",
      path_lookup: { ".tag": "not_found" },
    },
  }
  const { conn } = h(() => json(notFoundBody, 409))
  await assert.rejects(
    () => conn.execute("files.delete", { path: "/does-not-exist.txt" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found",
  )
})

test("search and continue workflow uses search_v2 and continue_v2", async () => {
  const { conn, calls } = h((call) => {
    if (call.url.pathname === "/2/files/search_v2") return json({ ...sampleSearch, has_more: true, cursor: "s_cur_1" })
    if (call.url.pathname === "/2/files/search/continue_v2") return json(sampleSearch)
    return json({}, 404)
  })

  const page1 = (await conn.execute("files.search", { query: "invoice" })) as typeof sampleSearch
  assert.equal(calls[0]!.url.pathname, "/2/files/search_v2")
  assert.equal(page1.cursor, "s_cur_1")

  const page2 = (await conn.execute("files.searchContinue", { cursor: page1.cursor! })) as typeof sampleSearch
  assert.equal(calls[1]!.url.pathname, "/2/files/search/continue_v2")
  assert.deepEqual(calls[1]!.body, { cursor: "s_cur_1" })
  assert.equal(page2.has_more, false)
})
