import { z } from "zod"
import type { ActionDefinition, ConnectorDefinition } from "./define.js"

/**
 * Static quality checks every connector must pass (docs/writing-connectors.md). Returns a list of problems;
 * an empty list means the connector is well-formed. It catches the mistakes that hand-writing many
 * connectors makes over and over: a path parameter missing from the input, a write marked safe to retry,
 * a paginated action without a cursor input, a placeholder left in a description.
 *
 * It checks SHAPE, not truth: it cannot know whether a path exists at the provider. That is what the
 * per-connector tests and the "live-tested" status are for.
 *
 * Third-party connector authors can run it on their own connectors too.
 */
export function checkConnector(connector: ConnectorDefinition<Record<string, ActionDefinition>>, options: { requireMeta?: boolean } = {}): string[] {
  const problems: string[] = []
  const fail = (message: string) => problems.push(message)
  const requireMeta = options.requireMeta ?? true

  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(connector.name) || connector.name.length > 40) {
    fail(`name "${connector.name}" must be lowercase letters/digits with single hyphens, at most 40 characters`)
  }
  if (!/^https:\/\//.test(connector.baseUrl)) fail(`baseUrl must be https (got "${connector.baseUrl}")`)
  if (/example\.(com|org)/.test(connector.baseUrl)) fail("baseUrl is still a placeholder")

  // ---- auth
  const auth = connector.auth
  if (auth.type === "apiKey" && !auth.header) fail("auth.apiKey needs a header name")
  if (auth.type === "oauth2") {
    for (const field of ["authorizeUrl", "tokenUrl"] as const) {
      if (!auth[field].startsWith("https://")) fail(`auth.${field} must be https`)
    }
  }

  // ---- meta
  const meta = connector.meta
  if (requireMeta && !meta) {
    fail("meta is required (title, description, docsUrl, status, credentialEnv)")
  } else if (meta) {
    if (!meta.title.trim()) fail("meta.title is empty")
    if (meta.description.trim().length < 15) fail("meta.description must say what the connector does (at least 15 characters)")
    if (!/^https:\/\/(?!example\.)/.test(meta.docsUrl)) fail("meta.docsUrl must be the provider's real https documentation URL")
    if (meta.status !== "live-tested" && meta.status !== "docs-based") fail(`meta.status must be "live-tested" or "docs-based"`)
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(meta.credentialEnv)) fail("meta.credentialEnv must be an UPPER_SNAKE environment variable name")
    for (const [field, value] of Object.entries(meta)) if (/\bTODO\b/i.test(String(value))) fail(`meta.${field} still contains TODO`)
  }

  // ---- actions
  const names = Object.keys(connector.actions)
  if (names.length === 0) fail("a connector needs at least one action")
  if (names.length > 40) fail(`${names.length} actions is too many: an agent that sees this many tools chooses worse. Curate to the 40 most useful`)

  const toolNames = new Set<string>()
  for (const name of names) {
    const action = connector.actions[name]!
    const at = `action "${name}"`

    if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(name)) fail(`${at}: name must look like "resource.verb" (letters and digits, dots between parts)`)
    const tool = `${connector.name}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_")
    if (tool.length > 64) fail(`${at}: the LLM tool name "${tool}" is longer than 64 characters`)
    if (toolNames.has(tool)) fail(`${at}: two actions produce the same tool name "${tool}"`)
    toolNames.add(tool)

    const description = action.description.trim()
    if (description.length < 30) fail(`${at}: description is too short for an LLM to choose the tool by (at least 30 characters)`)
    if (description.length > 500) fail(`${at}: description is longer than 500 characters; every tool description costs model context on every call`)
    if (/\bTODO\b/i.test(description)) fail(`${at}: description still contains TODO`)

    if (!action.path.startsWith("/")) fail(`${at}: path must start with "/"`)

    // effect must agree with the HTTP method (RPC-style providers that POST reads may declare effect "read")
    if (action.method === "GET" && action.effect !== "read") fail(`${at}: a GET must have effect "read"`)
    if (action.method === "DELETE" && action.effect !== "destructive") fail(`${at}: a DELETE must have effect "destructive"`)
    if (action.effect === "destructive" && action.method !== "DELETE" && !/\b(delete|remov|revok|cancel|destroy|archiv|void|refund|terminat)/i.test(`${name} ${description}`)) {
      fail(`${at}: effect "destructive" on a ${action.method} should say in the description what is destroyed`)
    }

    // retry safety: re-sending a POST can duplicate it
    if (action.safeToRetry && action.method === "POST") fail(`${at}: a POST must not be safeToRetry (a retry after a timeout could duplicate it)`)
    if (action.safeToRetry && action.effect === "read") fail(`${at}: safeToRetry is meaningless on a read (reads are always retried)`)

    // input schema
    let input: { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: string[] } | undefined
    try {
      input = z.toJSONSchema(action.input, { io: "input" }) as typeof input
    } catch (error) {
      fail(`${at}: input schema cannot be turned into JSON Schema for LLM tools (${error instanceof Error ? error.message : "unknown"})`)
    }
    if (input) {
      if (input.type !== "object") fail(`${at}: input must be an object schema`)
      const properties = input.properties ?? {}
      const required = new Set(input.required ?? [])
      for (const [, param] of action.path.matchAll(/\{(\w+)\}/g)) {
        if (!param || !(param in properties)) fail(`${at}: path parameter {${param}} is not in the input schema`)
        else if (!required.has(param)) fail(`${at}: path parameter {${param}} must be required in the input schema`)
      }

      if (action.paginate) {
        if (properties.cursor?.type !== "string") fail(`${at}: a paginated action needs an optional string "cursor" input`)
        if (!["number", "integer"].includes(String(properties.pageSize?.type))) fail(`${at}: a paginated action needs an optional number "pageSize" input`)
        if (required.has("cursor") || required.has("pageSize")) fail(`${at}: "cursor" and "pageSize" must be optional`)
        if (action.method !== "GET") fail(`${at}: paginated actions are expected to be GET`)
        let outputType: unknown
        try {
          outputType = (z.toJSONSchema(action.output) as { type?: unknown }).type
        } catch {
          // reported below
        }
        if (outputType !== "array") fail(`${at}: a paginated action's output must be z.array(item) (the list, not the whole body)`)
      }
    }
  }
  return problems
}
