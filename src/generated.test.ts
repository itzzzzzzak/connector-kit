// Runs EVERY action of every connector that has generated actions against a fake server and checks the routing:
// the method, the path (placeholders filled and encoded), and that each input field arrives exactly once, in the
// query string or in the JSON body, under its documented name. This is what catches a generator bug across
// hundreds of actions at once. It cannot know whether the provider agrees; that is what live tests are for.
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { z } from "zod"
import { harness, json } from "./connector-harness.test.js"
import type { ActionDefinition, ConnectorDefinition } from "./index.js"

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; anyOf?: Schema[]; oneOf?: Schema[] }
const dummy = (s: Schema | undefined): unknown => {
  if (!s) return "x"
  if (s.enum?.length) return s.enum[0]
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type
  if (t === "number" || t === "integer") return 1
  if (t === "boolean") return true
  if (t === "array") return [dummy(s.items)]
  if (t === "object") {
    const entries = Object.entries(s.properties ?? {}).map(([k, v]) => [k, dummy(v)] as const)
    return entries.length > 0 ? Object.fromEntries(entries) : { x: "x" } // an open object (a record) gets one key, so a form body has something to carry
  }
  if (t === "string") return "x"
  if (s.anyOf?.[0]) return dummy(s.anyOf[0])
  if (s.oneOf?.[0]) return dummy(s.oneOf[0])
  return "x"
}

// `expand[0]` and `created[gte]` of a form-encoded request count as the field `expand` and `created`.
const topNames = (names: Iterable<string>): Set<string> => new Set([...names].map((n) => n.replace(/\[.*$/, "")))

const folders = readdirSync(new URL("./connectors/", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`./connectors/${d.name}/generated/index.js`, import.meta.url)))

for (const folder of folders) {
  test(`${folder.name}: every generated action sends the right request`, async () => {
    const module = (await import(new URL(`./connectors/${folder.name}/index.js`, import.meta.url).href)) as { default: ConnectorDefinition<Record<string, ActionDefinition>> }
    const generated = ((await import(new URL(`./connectors/${folder.name}/generated/index.js`, import.meta.url).href)) as { generatedActions: Record<string, ActionDefinition> }).generatedActions
    const connector = module.default
    const variables = Object.fromEntries(Object.entries(connector.variables ?? {}).map(([k, v]) => [k, v.example]))
    const problems: string[] = []
    for (const [name, action] of Object.entries(generated)) {
      if (connector.actions[name] !== action) continue // overridden by a hand-written action
      const schema = z.toJSONSchema(action.input, { io: "input" }) as Schema & { required?: string[] }
      const input: Record<string, unknown> = {}
      for (const [key, prop] of Object.entries(schema.properties ?? {})) if (key !== "cursor" && key !== "pageSize") input[key] = dummy(prop)
      const pathKeys = [...action.path.matchAll(/\{\+?(\w+)\}/g)].map((m) => m[1]!)
      const { conn, calls } = harness(connector, () => json(action.paginate ? (action.paginate.itemsKey ? { [action.paginate.itemsKey]: [] } : []) : {}), { variables, credentials: { token: connector.auth.type === "basic" || connector.auth.type === "apiKeys" ? "user:pass" : "test-token" } })
      try {
        await conn.execute(name as never, input as never)
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`)
        continue
      }
      const call = calls[0]
      if (!call) { problems.push(`${name}: nothing was sent`); continue }
      if (call.init.method !== action.method) problems.push(`${name}: sent ${call.init.method}, expected ${action.method}`)
      const expectedPath = action.path.replace(/\{(\+?)(\w+)\}/g, (_, plus: string, k: string) => (plus ? String(input[k]).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(input[k]))))
      if (!call.url.pathname.endsWith(expectedPath)) problems.push(`${name}: path ${call.url.pathname} does not end with ${expectedPath}`)
      const body = call.body && typeof call.body === "object" && !Array.isArray(call.body) ? (call.body as Record<string, unknown>) : {}
      const queryNames = topNames(call.url.searchParams.keys())
      const formNames = typeof call.body === "string" ? topNames(new URLSearchParams(call.body).keys()) : new Set<string>()
      for (const key of Object.keys(input)) {
        if (pathKeys.includes(key)) continue
        const inQuery = queryNames.has(key)
        const inBody = key in body || formNames.has(key) || (key === "body" && call.body !== undefined)
        // A few fields are renamed on the wire (e.g. a name with a character that is not valid in a TS identifier); those are skipped here.
        const renamed = action.buildQuery?.toString().includes("pickAs") || action.buildBody?.toString().includes("pickAs")
        if (!renamed && inQuery === inBody) problems.push(`${name}: field "${key}" arrived ${inQuery && inBody ? "twice" : "nowhere"}`)
      }
      if (action.method === "GET" && call.init.body !== undefined) problems.push(`${name}: a GET sent a body`)
    }
    assert.deepEqual(problems.slice(0, 20), [], `${problems.length} problems`)
  })
}
