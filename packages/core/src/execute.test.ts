import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { ConnectorKitError, createConnectorKit, defineConnector } from "./index.js"

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
  },
})

const SECRET = "super-secret-token"

function kitWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchMock = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  const kit = createConnectorKit({ fetch: fetchMock })
  const conn = kit.connect(demo, { connectionId: "u1", credentials: { token: SECRET } })
  return { conn, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

test("fills path params, sends leftovers as query, and adds the bearer header", async () => {
  const { conn, calls } = kitWith(() => json({ id: "42", name: "Widget" }))
  const result = await conn.execute("items.get", { id: "42", expand: "owner" })

  assert.deepEqual(result, { id: "42", name: "Widget" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.toString(), "https://api.example.com/items/42?expand=owner")
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${SECRET}`)
})

test("invalid input is rejected before any network call", async () => {
  const { conn, calls } = kitWith(() => json({}))
  await assert.rejects(
    () => conn.execute("items.get", { id: 123 } as never),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "invalid_input" && !e.retryable,
  )
  assert.equal(calls.length, 0)
})

test("404 maps to not_found", async () => {
  const { conn } = kitWith(() => json({ message: "nope" }, 404))
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found" && e.status === 404,
  )
})

test("429 maps to rate_limited, retryable, and carries Retry-After", async () => {
  const { conn } = kitWith(() => json({}, 429, { "retry-after": "7" }))
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "rate_limited" && e.retryable && e.retryAfter === 7,
  )
})

test("a malformed provider response becomes upstream_error", async () => {
  const { conn } = kitWith(() => json({ unexpected: true }))
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error",
  )
})

test("errors never contain the token", async () => {
  const { conn } = kitWith(() => json({}, 401))
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

test("a network failure is retryable upstream_error without leaking details", async () => {
  const { conn } = kitWith(() => {
    throw new Error(`connect ECONNREFUSED with header ${SECRET}`)
  })
  await assert.rejects(
    () => conn.execute("items.get", { id: "x" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "upstream_error" && e.retryable && !e.message.includes(SECRET),
  )
})
