import { z } from "zod"
import { fixedHostSuffix, hostPartOf, placeholdersOf, variableMatches } from "./base-url.js"
import { headerTemplateSlots, type ActionDefinition, type ConnectorDefinition } from "./define.js"

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

  // ---- base URL variables (ADR-017)
  const used = placeholdersOf(connector.baseUrl)
  const declared = connector.variables ?? {}
  const pathPart = connector.baseUrl.replace(/^https:\/\//, "").slice(hostPartOf(connector.baseUrl).length)
  if (placeholdersOf(pathPart).length > 0) fail("baseUrl placeholders are only allowed in the host (a value in the path could escape it)")
  for (const name of used) if (!(name in declared)) fail(`baseUrl uses {${name}} but "variables" does not declare it`)
  for (const [name, spec] of Object.entries(declared)) {
    if (!used.includes(name)) fail(`variable "${name}" is declared but not used in baseUrl`)
    if (!spec.description.trim() || /\bTODO\b/.test(spec.description)) fail(`variable "${name}" needs a real description`)
    if (spec.values !== undefined && spec.values.length === 0) fail(`variable "${name}": "values" must not be empty`)
    if (spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern)
      } catch {
        fail(`variable "${name}": pattern is not a valid regular expression`)
      }
    }
    let exampleOk = false
    try {
      exampleOk = variableMatches(spec, spec.example)
    } catch {
      exampleOk = true // an invalid pattern is already reported above; do not crash on it
    }
    if (!exampleOk) fail(`variable "${name}": the example "${spec.example}" does not satisfy its own pattern or values`)
  }
  if (used.length > 0) {
    const suffix = fixedHostSuffix(connector.baseUrl)
    if (suffix === "") {
      const last = used[used.length - 1]!
      if (!declared[last]?.values) fail(`baseUrl ends its host with {${last}}: that variable must declare a closed list of "values" (otherwise it could name any server)`)
    } else if (!suffix.includes(".")) {
      fail(`baseUrl must keep a fixed domain after the last placeholder (got "${suffix}")`)
    }
  }

  // ---- auth
  const auth = connector.auth
  if (auth.type === "apiKey" && !auth.header) fail("auth.apiKey needs a header name")
  if (auth.type === "apiKeys") {
    if (auth.headers.length < 2) fail("auth.apiKeys needs at least two header names (use apiKey for one)")
    if (new Set(auth.headers.map((h) => h.toLowerCase())).size !== auth.headers.length) fail("auth.apiKeys header names must be different")
    for (const name of auth.headers) if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) fail(`auth.apiKeys header "${name}" is not a valid header name`)
  }
  if (auth.type === "headerTemplate") {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(auth.header)) fail(`auth.headerTemplate header "${auth.header}" is not a valid header name`)
    const slots = [...auth.template.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]))
    const needed = headerTemplateSlots(auth.template)
    if (needed < 1 || !Array.from({ length: needed }, (_, i) => i + 1).every((n) => slots.includes(n))) fail("auth.headerTemplate template needs numbered slots {1}, {2}, ... with no gaps")
    if (/[\r\n]/.test(auth.template)) fail("auth.headerTemplate template cannot contain a line break")
  }
  if (auth.type === "pathToken" && auth.prefix !== undefined && !/^[A-Za-z0-9_-]{0,16}$/.test(auth.prefix)) fail("auth.pathToken prefix must be at most 16 letters, digits, - or _")
  if (auth.type === "oauth2") {
    for (const field of ["authorizeUrl", "tokenUrl"] as const) {
      if (!auth[field].startsWith("https://")) fail(`auth.${field} must be https`)
      if (placeholdersOf(auth[field]).length > 0) fail(`auth.${field} cannot contain {placeholders} yet`)
    }
    if (auth.rawTokenPattern !== undefined) {
      try { new RegExp(auth.rawTokenPattern) } catch { fail("auth.rawTokenPattern is not a valid regular expression") }
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
    for (const [field, value] of Object.entries(meta)) if (/\bTODO\b/.test(String(value))) fail(`meta.${field} still contains TODO`)
  }

  // ---- actions
  const names = Object.keys(connector.actions)
  if (names.length === 0) fail("a connector needs at least one action")
  // Large connectors are fine (full API coverage): the MCP command and toTools() expose them by group, never all at once.
  if (names.length > 2000) fail(`${names.length} actions is more than the checker expects; split the connector`)

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
    if (/\bTODO\b/.test(description)) fail(`${at}: description still contains TODO`)

    if (!action.path.startsWith("/")) fail(`${at}: path must start with "/"`)

    // effect must agree with the HTTP method (RPC-style providers that POST reads may declare effect "read")
    if (action.method === "GET" && action.effect !== "read") fail(`${at}: a GET must have effect "read"`)
    if (action.method === "DELETE" && action.effect !== "destructive") fail(`${at}: a DELETE must have effect "destructive"`)
    if (action.effect === "destructive" && action.method !== "DELETE" && !/\b(delete|remov|revok|cancel|destroy|archiv|void|refund|terminat|reject|deactivat|expire|close|trash|purg|wip|suspend|clear|block|stop|empty|ban|kick|prun|disabl|mut)/i.test(`${name} ${description}`)) {
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
      for (const [, param] of action.path.matchAll(/\{\+?(\w+)\}/g)) {
        if (!param || !(param in properties)) fail(`${at}: path parameter {${param}} is not in the input schema`)
        // Optional is fine ONLY with a default (e.g. userId defaults to "me"): the value is then always present.
        else if (!required.has(param) && (properties[param] as { default?: unknown }).default === undefined) fail(`${at}: path parameter {${param}} must be required in the input schema (or have a default)`)
      }

      if (action.paginate) {
        if (properties.cursor?.type !== "string") fail(`${at}: a paginated action needs an optional string "cursor" input`)
        if (action.paginate.pageSizeParam && !["number", "integer"].includes(String(properties.pageSize?.type))) fail(`${at}: a paginated action needs an optional number "pageSize" input`)
        if (required.has("cursor") || required.has("pageSize")) fail(`${at}: "cursor" and "pageSize" must be optional`)
        if (action.method !== "GET" && action.paginate.cursorIn !== "body") fail(`${at}: paginated actions are expected to be GET (unless the cursor travels in the body)`)
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
