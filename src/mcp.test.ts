import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { z } from "zod"
import { createConnectorKit, defineConnector } from "./index.js"
import { createMcpHandler, serveMcp } from "./mcp.js"

const demo = defineConnector({
  name: "demo",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer" },
  actions: {
    "items.get": {
      description: "Get an item by id.",
      method: "GET",
      path: "/items/{id}",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), blob: z.string().optional() }),
      effect: "read",
    },
    "items.delete": { description: "Delete an item.", method: "DELETE", path: "/items/{id}", input: z.object({ id: z.string() }), output: z.undefined(), effect: "destructive" },
  },
})

const SECRET = "tok_mcp_secret"

function setup(respond: () => Response = () => new Response(JSON.stringify({ id: "1" }), { status: 200 }), options = {}) {
  const kit = createConnectorKit({ retry: { maxRetries: 0 }, fetch: (async () => respond()) as typeof fetch })
  const tools = kit.toTools(kit.connect(demo, { connectionId: "c", credentials: { token: SECRET } }))
  return createMcpHandler(tools, options)
}
const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) })

test("initialize negotiates a supported protocol version and advertises tools", async () => {
  const res = await setup().handle(request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))
  assert.equal(res?.id, 1)
  const result = res?.result as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } }
  assert.equal(result.protocolVersion, "2025-06-18")
  assert.deepEqual(result.capabilities, { tools: {} })
  assert.equal(result.serverInfo.name, "connector-kit")
})

test("initialize with an unknown version answers with the newest one we support", async () => {
  const res = await setup().handle(request("initialize", { protocolVersion: "1999-01-01" }))
  assert.equal((res?.result as { protocolVersion: string }).protocolVersion, "2025-11-25")
})

test("notifications are never answered", async () => {
  assert.equal(await setup().handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined)
  assert.equal(await setup().handle({ jsonrpc: "2.0", method: "no/such/method" }), undefined)
})

test("ping returns an empty result", async () => {
  assert.deepEqual((await setup().handle(request("ping")))?.result, {})
})

test("tools/list exposes names, schemas, and safety annotations from the effect label", async () => {
  const { tools } = (await setup().handle(request("tools/list")))?.result as { tools: Array<Record<string, any>> }
  assert.deepEqual(tools.map((t) => t.name), ["demo_items_get", "demo_items_delete"])
  assert.equal(tools[0]!.inputSchema.type, "object")
  assert.deepEqual(tools[0]!.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true })
  assert.deepEqual(tools[1]!.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true })
})

test("tools/call returns the data as JSON text", async () => {
  const res = await setup().handle(request("tools/call", { name: "demo_items_get", arguments: { id: "1" } }))
  const result = res?.result as { content: Array<{ type: string; text: string }>; isError: boolean }
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content[0]!.text), { id: "1" })
})

test("an API failure is a tool error (isError) the model can read, with no token or raw body", async () => {
  const res = await setup(() => new Response(JSON.stringify({ message: "provider secret detail" }), { status: 401 })).handle(
    request("tools/call", { name: "demo_items_get", arguments: { id: "1" } }),
  )
  const result = res?.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0]!.text).code, "auth_expired")
  assert.ok(!result.content[0]!.text.includes(SECRET))
  assert.ok(!result.content[0]!.text.includes("provider secret detail"))
})

test("bad arguments from a model come back as invalid_input, not a protocol error", async () => {
  const res = await setup().handle(request("tools/call", { name: "demo_items_get", arguments: { id: 5 } }))
  assert.equal(res?.error, undefined)
  const result = res?.result as { content: Array<{ text: string }>; isError: boolean }
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0]!.text).code, "invalid_input")
})

test("an unknown tool is a JSON-RPC invalid-params error", async () => {
  const res = await setup().handle(request("tools/call", { name: "demo_nope", arguments: {} }))
  assert.equal(res?.error?.code, -32602)
})

test("an unknown method is method-not-found", async () => {
  assert.equal((await setup().handle(request("resources/list")))?.error?.code, -32601)
})

test("a non-object message is an invalid request", async () => {
  assert.equal((await setup().handle("hello"))?.error?.code, -32600)
  assert.equal((await setup().handle([1, 2]))?.error?.code, -32600)
})

test("huge results are truncated with a hint instead of flooding the model", async () => {
  const big = () => new Response(JSON.stringify({ id: "1", blob: "x".repeat(5_000) }), { status: 200 })
  const res = await setup(big, { maxResultChars: 200 }).handle(request("tools/call", { name: "demo_items_get", arguments: { id: "1" } }))
  const text = (res?.result as { content: Array<{ text: string }> }).content[0]!.text
  assert.ok(text.length < 400)
  assert.match(text, /truncated/)
})

test("an unexpected internal failure is reported generically and logged, never detailed to the client", async () => {
  const logged: unknown[] = []
  const handler = createMcpHandler(
    [{ name: "boom", description: "d", inputSchema: { type: "object" }, effect: "read", run: async () => { throw new Error("db password is hunter2") } }],
    { onError: (e) => logged.push(e) },
  )
  const res = await handler.handle(request("tools/call", { name: "boom", arguments: {} }))
  assert.equal(res?.error?.code, -32603)
  assert.equal(res?.error?.message, "Internal error")
  assert.equal(logged.length, 1)
})

// ----------------------------------------------------------------- stdio framing

test("stdio: answers requests line by line, ignores notifications and blank lines, reports parse errors", async () => {
  const kit = createConnectorKit({ fetch: (async () => new Response(JSON.stringify({ id: "1" }))) as typeof fetch })
  const tools = kit.toTools(kit.connect(demo, { connectionId: "c", credentials: { token: SECRET } }))
  const input = new PassThrough()
  const output = new PassThrough()
  const served = serveMcp(tools, { input, output })

  input.write(`${JSON.stringify(request("ping", undefined, 7))}\n`)
  input.write(`\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  input.write(`{not json\n`)
  input.end(`${JSON.stringify(request("ping", undefined, "b"))}\n`)
  await served
  output.end()

  const lines = (await new Promise<string>((resolve) => {
    let data = ""
    output.on("data", (c) => (data += c))
    output.on("end", () => resolve(data))
  }))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))

  assert.equal(lines.length, 3)
  assert.deepEqual(lines.find((l) => l.id === 7), { jsonrpc: "2.0", id: 7, result: {} })
  assert.deepEqual(lines.find((l) => l.id === "b"), { jsonrpc: "2.0", id: "b", result: {} })
  assert.equal(lines.find((l) => l.id === null).error.code, -32700)
})
