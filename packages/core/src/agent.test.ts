import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { ConnectorKitError, createConnectorKit, defineConnector, type BeforeExecute, type KitOptions } from "./index.js"

const demo = defineConnector({
  name: "demo",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer" },
  actions: {
    "items.get": {
      description: "Get an item by id. Use when the user asks about one item.",
      method: "GET",
      path: "/items/{id}",
      input: z.object({ id: z.string().describe("The item id") }),
      output: z.object({ id: z.string() }),
      effect: "read",
    },
    "items.delete": {
      description: "Delete an item.",
      method: "DELETE",
      path: "/items/{id}",
      input: z.object({ id: z.string() }),
      output: z.undefined(),
      effect: "destructive",
    },
  },
})

const SECRET = "tok_super_secret"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function setup(handler: () => Response, options: KitOptions = {}) {
  const calls: string[] = []
  const kit = createConnectorKit({
    retry: { maxRetries: 0 },
    ...options,
    fetch: (async (input: URL | string) => {
      calls.push(String(input))
      return handler()
    }) as typeof fetch,
  })
  return { kit, conn: kit.connect(demo, { connectionId: "user_7", credentials: { token: SECRET } }), calls }
}

// ------------------------------------------------------------ beforeExecute (ADR-007)

test("the hook sees the action, its effect, the validated input and the connection", async () => {
  let seen: Parameters<BeforeExecute>[0] | undefined
  const { conn } = setup(() => json({ id: "1" }), { beforeExecute: (ctx) => ((seen = ctx), { allow: true }) })
  await conn.execute("items.get", { id: "1" })
  assert.deepEqual(seen, { connector: "demo", action: "items.get", effect: "read", input: { id: "1" }, connectionId: "user_7" })
})

test("a denied action never reaches the network and tells the caller why", async () => {
  const { conn, calls } = setup(() => new Response(null, { status: 204 }), {
    beforeExecute: ({ effect }) => (effect === "destructive" ? { allow: false, reason: "needs human approval" } : { allow: true }),
  })
  await assert.rejects(
    () => conn.execute("items.delete", { id: "1" }),
    (e: unknown) => e instanceof ConnectorKitError && e.code === "denied" && !e.retryable && e.message.includes("needs human approval"),
  )
  assert.equal(calls.length, 0)
})

test("an allowed action runs normally", async () => {
  const { conn, calls } = setup(() => json({ id: "1" }), { beforeExecute: () => ({ allow: true }) })
  assert.deepEqual(await conn.execute("items.get", { id: "1" }), { id: "1" })
  assert.equal(calls.length, 1)
})

test("an async hook is awaited (e.g. while a human decides)", async () => {
  const { conn, calls } = setup(() => json({ id: "1" }), {
    beforeExecute: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { allow: false, reason: "no" }
    },
  })
  await assert.rejects(() => conn.execute("items.get", { id: "1" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "denied")
  assert.equal(calls.length, 0)
})

test("if the hook throws, the action does NOT run (fail closed)", async () => {
  const { conn, calls } = setup(() => json({ id: "1" }), {
    beforeExecute: () => {
      throw new Error("approval service is down")
    },
  })
  await assert.rejects(() => conn.execute("items.get", { id: "1" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "denied")
  assert.equal(calls.length, 0)
})

test("the hook is not called for invalid input (validation comes first)", async () => {
  let called = false
  const { conn } = setup(() => json({}), { beforeExecute: () => ((called = true), { allow: true }) })
  await assert.rejects(() => conn.execute("items.get", { id: 5 } as never), (e: unknown) => e instanceof ConnectorKitError && e.code === "invalid_input")
  assert.equal(called, false)
})

test("the hook runs once per call, not once per retry", async () => {
  let hookCalls = 0
  let n = 0
  const { conn, calls } = setup(() => (++n === 1 ? json({}, 503) : json({ id: "1" })), {
    retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 },
    beforeExecute: () => (hookCalls++, { allow: true }),
  })
  await conn.execute("items.get", { id: "1" })
  assert.equal(calls.length, 2)
  assert.equal(hookCalls, 1)
})

// ------------------------------------------------------------ toTools (ADR-011)

test("toTools turns actions into LLM tool definitions with JSON Schema", () => {
  const { kit, conn } = setup(() => json({}))
  const tools = kit.toTools(conn)
  assert.deepEqual(tools.map((t) => t.name), ["demo_items_get", "demo_items_delete"])

  const get = tools[0]!
  assert.equal(get.description, "Get an item by id. Use when the user asks about one item.")
  assert.equal(get.effect, "read")
  assert.equal(get.inputSchema.type, "object")
  assert.deepEqual(get.inputSchema.required, ["id"])
  assert.equal((get.inputSchema.properties as Record<string, { description?: string }>).id!.description, "The item id")
  assert.equal("$schema" in get.inputSchema, false)
})

test("tool names only use characters LLM APIs accept", () => {
  const { kit, conn } = setup(() => json({}))
  for (const tool of kit.toTools(conn)) assert.match(tool.name, /^[A-Za-z0-9_-]+$/)
})

test("`only` limits which actions are exposed; an unknown action fails loudly", () => {
  const { kit, conn } = setup(() => json({}))
  assert.deepEqual(kit.toTools(conn, { only: ["items.get"] }).map((t) => t.name), ["demo_items_get"])
  assert.throws(() => kit.toTools(conn, { only: ["items.nope"] }), /no action "items.nope"/)
})

test("tool.run returns { ok: true, data } on success", async () => {
  const { kit, conn } = setup(() => json({ id: "1" }))
  const [get] = kit.toTools(conn, { only: ["items.get"] })
  assert.deepEqual(await get!.run({ id: "1" }), { ok: true, data: { id: "1" } })
})

test("tool.run turns API failures into readable results instead of throwing", async () => {
  const { kit, conn } = setup(() => new Response(JSON.stringify({ message: "secret provider detail" }), { status: 404 }))
  const [get] = kit.toTools(conn, { only: ["items.get"] })
  const result = await get!.run({ id: "1" })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, "not_found")
    assert.equal(result.error.retryable, false)
    assert.ok(result.error.message.length > 0)
  }
})

test("tool results never contain the token or raw provider bodies", async () => {
  const { kit, conn } = setup(() => new Response(JSON.stringify({ message: "secret provider detail" }), { status: 401 }))
  const [get] = kit.toTools(conn, { only: ["items.get"] })
  const serialized = JSON.stringify(await get!.run({ id: "1" }))
  assert.ok(!serialized.includes(SECRET))
  assert.ok(!serialized.includes("secret provider detail"))
})

test("a model's bad arguments come back as invalid_input it can correct", async () => {
  const { kit, conn, calls } = setup(() => json({}))
  const [get] = kit.toTools(conn, { only: ["items.get"] })
  const result = await get!.run({ id: 42 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, "invalid_input")
  assert.equal(calls.length, 0)
})

test("a denial reaches the model as { ok: false, code: 'denied' }", async () => {
  const { kit, conn } = setup(() => json({}), { beforeExecute: () => ({ allow: false, reason: "read-only mode" }) })
  const [get] = kit.toTools(conn, { only: ["items.get"] })
  const result = await get!.run({ id: "1" })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, "denied")
    assert.ok(result.error.message.includes("read-only mode"))
  }
})
