import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { checkConnector, defineConnector, type ActionDefinition } from "./index.js"

const meta = { title: "Acme", description: "Does acme things for agents.", docsUrl: "https://acme.dev/docs", status: "docs-based", credentialEnv: "ACME_TOKEN" } as const
const read = (over: Partial<ActionDefinition> = {}): ActionDefinition => ({
  description: "Get a thing by id. Use when the user asks about one thing.",
  method: "GET",
  path: "/things/{id}",
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string() }),
  effect: "read",
  ...over,
})
const make = (actions: Record<string, ActionDefinition>, over: Record<string, unknown> = {}) =>
  defineConnector({ name: "acme", baseUrl: "https://api.acme.dev/v1", auth: { type: "bearer" }, meta, actions, ...over } as never) as Parameters<typeof checkConnector>[0]
const problems = (c: Parameters<typeof checkConnector>[0]) => checkConnector(c).join(" | ")

test("a well-formed connector has no problems", () => {
  assert.deepEqual(checkConnector(make({ "things.get": read() })), [])
})

test("bad connector names and non-https base URLs are flagged", () => {
  assert.match(problems(make({ "a.b": read() }, { name: "Acme_Corp" })), /name "Acme_Corp"/)
  assert.match(problems(make({ "a.b": read() }, { baseUrl: "http://api.acme.dev" })), /baseUrl must be https/)
  assert.match(problems(make({ "a.b": read() }, { baseUrl: "https://api.example.com" })), /placeholder/)
})

test("missing or placeholder metadata is flagged", () => {
  assert.match(problems(make({ "a.b": read() }, { meta: undefined })), /meta is required/)
  assert.match(problems(make({ "a.b": read() }, { meta: { ...meta, description: "TODO describe it please" } })), /TODO/)
  assert.match(problems(make({ "a.b": read() }, { meta: { ...meta, docsUrl: "https://example.com/docs" } })), /docsUrl/)
  assert.match(problems(make({ "a.b": read() }, { meta: { ...meta, credentialEnv: "token" } })), /credentialEnv/)
  assert.match(problems(make({ "a.b": read() }, { meta: { ...meta, status: "great" } })), /status/)
})

test("a path parameter missing from the input, or optional, is flagged", () => {
  assert.match(problems(make({ "a.b": read({ input: z.object({ other: z.string() }) }) })), /\{id\} is not in the input/)
  assert.match(problems(make({ "a.b": read({ input: z.object({ id: z.string().optional() }) }) })), /\{id\} must be required/)
})

test("only the uppercase TODO placeholder is flagged; the ordinary word 'Todo' is fine", () => {
  assert.deepEqual(checkConnector(make({ "a.b": read({ description: "List records where the Status is 'Todo' or 'Done'. Use for task boards." }) })), [])
  assert.match(problems(make({ "a.b": read({ description: "TODO: write what this returns for a model" }) })), /TODO/)
})

test("descriptions that are too short, too long or unfinished are flagged", () => {
  assert.match(problems(make({ "a.b": read({ description: "Get it" }) })), /too short/)
  assert.match(problems(make({ "a.b": read({ description: "x".repeat(501) }) })), /longer than 500/)
  assert.match(problems(make({ "a.b": read({ description: "TODO write a proper description here" }) })), /TODO/)
})

test("the effect must agree with the HTTP method", () => {
  assert.match(problems(make({ "a.b": read({ effect: "write" }) })), /GET must have effect "read"/)
  assert.match(problems(make({ "a.b": read({ method: "DELETE", effect: "write", description: "Delete a thing permanently by id." }) })), /DELETE must have effect "destructive"/)
})

test("a POST marked safeToRetry is flagged; so is safeToRetry on a read", () => {
  const post = read({ method: "POST", path: "/things", input: z.object({ name: z.string() }), effect: "write", description: "Create a thing with the given name." })
  assert.match(problems(make({ "a.b": { ...post, safeToRetry: true } })), /POST must not be safeToRetry/)
  assert.match(problems(make({ "a.b": read({ safeToRetry: true }) })), /meaningless on a read/)
  assert.deepEqual(checkConnector(make({ "a.b": post })), [])
})

test("paginated actions need optional cursor/pageSize inputs and an array output", () => {
  const strategy = { pageSizeParam: "limit", defaultPageSize: 30, maxPageSize: 100, nextCursor: () => null, applyCursor: (u: URL) => u }
  const list = read({ path: "/things", input: z.object({}), output: z.array(z.object({ id: z.string() })), paginate: strategy })
  assert.match(problems(make({ "a.b": list })), /optional string "cursor"/)
  assert.match(problems(make({ "a.b": { ...list, input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }), output: z.object({}) } })), /output must be z\.array/)
  assert.match(problems(make({ "a.b": { ...list, input: z.object({ cursor: z.string(), pageSize: z.number().optional() }) } })), /must be optional/)
  assert.deepEqual(checkConnector(make({ "a.b": { ...list, input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }) } })), [])
})

test("two actions that collapse to the same tool name, and an over-long tool name, are flagged", () => {
  assert.match(problems(make({ "a.b": read(), a_b: read() })), /same tool name/)
  const long = "x".repeat(60)
  assert.match(problems(make({ [`${long}.get`]: read() })), /longer than 64/)
})

test("a connector with no actions, or an absurd number, is flagged", () => {
  assert.match(problems(make({})), /at least one action/)
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`r${i}.get`, read()]))
  assert.match(problems(make(many)), /too many/)
})

test("an input that cannot become JSON Schema (so cannot become an LLM tool) is flagged", () => {
  assert.match(problems(make({ "a.b": read({ input: z.object({ id: z.string(), fn: z.custom<() => void>(() => true) }) }) })), /JSON Schema/)
})

test("oauth urls must be https", () => {
  assert.match(problems(make({ "a.b": read() }, { auth: { type: "oauth2", authorizeUrl: "http://a.test/a", tokenUrl: "https://a.test/t" } })), /authorizeUrl must be https/)
})
