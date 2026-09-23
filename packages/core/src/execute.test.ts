import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { ConnectorKitError, createConnectorKit, defineConnector, type KitOptions } from "./index.js"

const demo = defineConnector({
  name: "demo",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer" },
  actions: {
    "items.get": {
      description: "Get an item.",
      method: "GET",
      path: "/items/{id}",
      input: z.object({ id: z.string(), expand: z.string().optional() }),
      output: z.object({ id: z.string(), name: z.string() }),
      effect: "read",
    },
    "items.search": {
      description: "Search items.",
      method: "GET",
      path: "/search",
      input: z.object({ q: z.string().optional(), tags: z.array(z.string()).optional(), meta: z.record(z.string(), z.number()).optional() }),
      output: z.object({ ok: z.boolean() }),
      effect: "read",
    },
    "items.create": {
      description: "Create an item.",
      method: "POST",
      path: "/collections/{collection}/items",
      input: z.object({ collection: z.string(), title: z.string() }),
      output: z.object({ id: z.string() }),
      effect: "write",
    },
    "items.delete": {
      description: "Delete an item.",
      method: "DELETE",
      path: "/items/{id}",
      input: z.object({ id: z.string() }),
      output: z.undefined(),
      effect: "destructive",
    },
    "things.get": {
      description: "Path param the schema does not require.",
      method: "GET",
      path: "/things/{id}",
      input: z.object({ id: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      effect: "read",
    },
  },
})

const keyed = defineConnector({
  name: "keyed",
  baseUrl: "https://api.example.com/v2/",
  auth: { type: "apiKey", header: "X-Api-Key", prefix: "Key " },
  actions: {
    ping: { description: "Ping.", method: "GET", path: "/ping", input: z.object({}), output: z.object({ ok: z.boolean() }), effect: "read" },
  },
})

const SECRET = "super-secret-token"

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function setup(handler: Handler, options: KitOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchMock = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  const kit = createConnectorKit({ ...options, fetch: fetchMock })
  const conn = kit.connect(demo, { connectionId: "u1", credentials: { token: SECRET } })
  const keyedConn = kit.connect(keyed, { connectionId: "u1", credentials: { token: SECRET } })
  return { conn, keyedConn, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const isKitError = (code: string, extra?: (e: ConnectorKitError) => boolean) => (e: unknown) =>
  e instanceof ConnectorKitError && e.code === code && (extra?.(e) ?? true)

// ---------------------------------------------------------------- happy path

test("fills path params, sends leftovers as query, and adds the bearer header", async () => {
  const { conn, calls } = setup(() => json({ id: "42", name: "Widget" }))
  const result = await conn.execute("items.get", { id: "42", expand: "owner" })

  assert.deepEqual(result, { id: "42", name: "Widget" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.toString(), "https://api.example.com/items/42?expand=owner")
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${SECRET}`)
})

test("apiKey auth uses the configured header and prefix; base URL paths are preserved", async () => {
  const { keyedConn, calls } = setup(() => json({ ok: true }))
  await keyedConn.execute("ping", {})
  assert.equal(calls[0]!.url.toString(), "https://api.example.com/v2/ping")
  assert.equal(new Headers(calls[0]!.init.headers).get("x-api-key"), `Key ${SECRET}`)
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), null)
})

test("POST sends a JSON body without the path params", async () => {
  const { conn, calls } = setup(() => json({ id: "9" }, 201))
  await conn.execute("items.create", { collection: "books", title: "Dune" })

  const { url, init } = calls[0]!
  assert.equal(init.method, "POST")
  assert.equal(url.toString(), "https://api.example.com/collections/books/items")
  assert.equal(init.body, JSON.stringify({ title: "Dune" }))
  assert.equal(new Headers(init.headers).get("content-type"), "application/json")
})

test("a 204 empty response is a valid result for an action with no output", async () => {
  const { conn } = setup(() => new Response(null, { status: 204 }))
  assert.equal(await conn.execute("items.delete", { id: "1" }), undefined)
})

// ---------------------------------------------------------------- input safety

test("invalid input is rejected before any network call", async () => {
  const { conn, calls } = setup(() => json({}))
  await assert.rejects(() => conn.execute("items.get", { id: 123 } as never), isKitError("invalid_input", (e) => !e.retryable))
  assert.equal(calls.length, 0)
})

test("unknown action names are rejected", async () => {
  const { conn, calls } = setup(() => json({}))
  await assert.rejects(() => conn.execute("nope" as never, {} as never), isKitError("invalid_input"))
  assert.equal(calls.length, 0)
})

test("path parameters cannot climb out of their segment ('.', '..', '')", async () => {
  // Regression: owner=".." used to turn /repos/{owner}/x into a request to a different endpoint.
  for (const id of [".", "..", ""]) {
    const { conn, calls } = setup(() => json({ id: "1", name: "n" }))
    await assert.rejects(() => conn.execute("items.get", { id }), isKitError("invalid_input"), `id=${JSON.stringify(id)}`)
    assert.equal(calls.length, 0, `id=${JSON.stringify(id)} must not reach the network`)
  }
})

test("path parameters are percent-encoded", async () => {
  const { conn, calls } = setup(() => json({ id: "1", name: "n" }))
  await conn.execute("items.get", { id: "a/b c?x=1" })
  assert.equal(calls[0]!.url.pathname, "/items/a%2Fb%20c%3Fx%3D1")
  assert.equal(calls[0]!.url.search, "")
})

test("a path parameter missing from the input is rejected", async () => {
  const { conn, calls } = setup(() => json({ ok: true }))
  await assert.rejects(() => conn.execute("things.get", {}), isKitError("invalid_input", (e) => e.message.includes('"id"')))
  assert.equal(calls.length, 0)
})

test("query arrays become repeated params and undefined values are skipped", async () => {
  const { conn, calls } = setup(() => json({ ok: true }))
  await conn.execute("items.search", { tags: ["a", "b"] })
  assert.equal(calls[0]!.url.search, "?tags=a&tags=b")
})

test("objects cannot be sent as query parameters", async () => {
  const { conn, calls } = setup(() => json({ ok: true }))
  await assert.rejects(() => conn.execute("items.search", { meta: { a: 1 } }), isKitError("invalid_input", (e) => e.message.includes('"meta"')))
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------- error mapping

test("404 maps to not_found", async () => {
  const { conn } = setup(() => json({ message: "nope" }, 404))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("not_found", (e) => e.status === 404))
})

test("401 maps to auth_expired and is not retryable", async () => {
  const { conn } = setup(() => json({}, 401))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("auth_expired", (e) => !e.retryable))
})

test("a plain 403 is forbidden, not retryable", async () => {
  const { conn } = setup(() => json({ message: "no" }, 403))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("forbidden", (e) => !e.retryable))
})

test("a 403 with an exhausted rate limit is rate_limited, using x-ratelimit-reset", async () => {
  const reset = Math.floor(Date.now() / 1000) + 5
  const { conn } = setup(() => json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }))
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    isKitError("rate_limited", (e) => e.retryable && e.retryAfter !== undefined && e.retryAfter >= 3 && e.retryAfter <= 6),
  )
})

test("429 maps to rate_limited, retryable, and carries Retry-After seconds", async () => {
  const { conn } = setup(() => json({}, 429, { "retry-after": "7" }))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("rate_limited", (e) => e.retryable && e.retryAfter === 7))
})

test("Retry-After may be an HTTP date", async () => {
  const when = new Date(Date.now() + 10_000).toUTCString()
  const { conn } = setup(() => json({}, 429, { "retry-after": when }))
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    isKitError("rate_limited", (e) => e.retryAfter !== undefined && e.retryAfter >= 8 && e.retryAfter <= 11),
  )
})

test("5xx is a retryable upstream_error", async () => {
  const { conn } = setup(() => json({}, 503))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error", (e) => e.retryable && e.status === 503))
})

test("the provider's response is kept in a non-enumerable `raw` field", async () => {
  const { conn } = setup(() => json({ message: "Not Found" }, 404))
  try {
    await conn.execute("items.get", { id: "x" })
    assert.fail("should have thrown")
  } catch (e) {
    assert.ok(e instanceof ConnectorKitError)
    assert.equal(e.raw?.status, 404)
    assert.ok(e.raw?.body.includes("Not Found"))
    // Not enumerable: does not leak through JSON.stringify or spreading into logs.
    assert.equal(Object.keys(e).includes("raw"), false)
    assert.ok(!JSON.stringify(e).includes("Not Found"))
  }
})

// ---------------------------------------------------------------- hostile / broken providers

test("a response with the wrong shape becomes upstream_error", async () => {
  const { conn } = setup(() => json({ unexpected: true }))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error"))
})

test("a response that is not JSON becomes upstream_error", async () => {
  const { conn } = setup(() => new Response("<html>oops</html>", { status: 200 }))
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error", (e) => e.message.includes("not valid JSON")))
})

test("an oversized response is rejected (streamed, no content-length)", async () => {
  const { conn } = setup(() => json({ id: "1", name: "n".repeat(500) }), { maxResponseBytes: 100 })
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error", (e) => e.message.includes("too large") && !e.retryable))
})

test("an oversized response is rejected early when content-length declares it", async () => {
  const { conn } = setup(() => json({ id: "1", name: "n" }, 200, { "content-length": "999999" }), { maxResponseBytes: 100 })
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error", (e) => e.message.includes("too large")))
})

test("a provider that never answers times out with a retryable error", async () => {
  const { conn } = setup(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      }),
    { timeoutMs: 30 },
  )
  await assert.rejects(() => conn.execute("items.get", { id: "x" }), isKitError("upstream_error", (e) => e.retryable && e.message.includes("30 ms")))
})

// ---------------------------------------------------------------- secrets

test("errors never contain the token", async () => {
  const { conn } = setup(() => json({}, 401))
  try {
    await conn.execute("items.get", { id: "x" })
    assert.fail("should have thrown")
  } catch (e) {
    assert.ok(e instanceof ConnectorKitError)
    assert.ok(!JSON.stringify(e).includes(SECRET))
    assert.ok(!e.message.includes(SECRET))
    assert.equal(e.code, "auth_expired")
  }
})

test("a network failure is a retryable upstream_error without leaking details", async () => {
  const { conn } = setup(() => {
    throw new Error(`connect ECONNREFUSED with header ${SECRET}`)
  })
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    isKitError("upstream_error", (e) => e.retryable && !e.message.includes(SECRET)),
  )
})
