// Generates a connector's action list from a provider's OFFICIAL OpenAPI / Swagger description:
//   node scripts/gen-openapi.mjs scripts/openapi/github.json [--spec path/to/local/spec]
// Output: src/connectors/<name>/generated/<group>.ts (one file per group) + generated/index.ts. The output is plain,
// reviewable TypeScript that is committed; this script is only run when the provider's API changes (see ADR-018).
// Inputs (path, query and top-level body fields) are typed from the spec. Responses are left open (z.unknown()),
// because response schemas in specs are large and wrong in small ways; a hand-written action always takes precedence.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

const [configPath, ...rest] = process.argv.slice(2)
if (!configPath) {
  console.error("Usage: node scripts/gen-openapi.mjs <config.json> [--spec local-file]")
  process.exit(2)
}
const config = JSON.parse(readFileSync(configPath, "utf8"))
const localSpec = rest[0] === "--spec" ? rest[1] : undefined
// One or several specifications feed one connector (e.g. HubSpot publishes one per API). Each may set `serverPath`
// (when its paths are relative to a different base than the spec says), `verbSuffix` (to tell two API generations apart)
// and `bundleRemoteRefs` (Mailchimp splits its description into one file per path).
const specDefs = config.specs ?? [{ url: config.spec }]
let spec
let swagger2
const remoteCache = new Map()
async function inlineRemoteRefs(node, depth = 0) {
  if (!node || typeof node !== "object") return node
  if (typeof node.$ref === "string" && /^https:\/\//.test(node.$ref)) {
    if (depth > 3) return {}
    let url = node.$ref
    for (const [from, to] of config.rewriteRemote ?? []) url = url.replace(new RegExp(from), to)
    if (!remoteCache.has(url)) remoteCache.set(url, (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await fetch(url)
        if (r.ok) return await r.json()
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) ** 2))
      }
      throw new Error(`could not fetch ${url}`) // never silently drop part of an API
    })())
    return inlineRemoteRefs(await remoteCache.get(url), depth + 1)
  }
  if (Array.isArray(node)) return Promise.all(node.map((n) => inlineRemoteRefs(n, depth)))
  const out = {}
  for (const [k, v] of Object.entries(node)) out[k] = await inlineRemoteRefs(v, depth)
  return out
}
async function loadSpec(def) {
  const text = localSpec ? readFileSync(localSpec, "utf8") : await (await fetch(def.url)).text()
  let parsed = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text)
  if (def.bundleRemoteRefs) {
    // Resolve the path files (and the definitions they point to) from the web, a few at a time.
    const entries = Object.entries(parsed.paths)
    const resolved = {}
    for (let i = 0; i < entries.length; i += 3) await Promise.all(entries.slice(i, i + 3).map(async ([p, item]) => { resolved[p] = await inlineRemoteRefs(item) }))
    parsed = { ...parsed, paths: resolved }
  }
  return parsed
}
// "spec" copies the provider's own summaries (only for permissively licensed specs). "derived" writes our own short
// description from the operation name, tag and path, and leaves out parameter descriptions: used when the spec's license is
// absent or restrictive, so no provider text is copied.
const derived = config.descriptions === "derived"
const outDir = `src/connectors/${config.name}/generated`
const connectorSource = readFileSync(`src/connectors/${config.name}/index.ts`, "utf8")

// ---------------------------------------------------------------- spec helpers
const resolveRef = (node, seen = 0) => {
  if (!node || typeof node !== "object" || !node.$ref || seen > 20) return node
  const target = node.$ref.replace(/^#\//, "").split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => o?.[k], spec)
  return resolveRef(target, seen + 1)
}
const mergeAllOf = (schema) => {
  schema = resolveRef(schema)
  if (!schema?.allOf) return schema
  const merged = { ...schema }
  delete merged.allOf
  for (const part of schema.allOf.map(mergeAllOf)) {
    merged.properties = { ...merged.properties, ...part?.properties }
    merged.required = [...(merged.required ?? []), ...(part?.required ?? [])]
    for (const k of ["type", "enum", "items", "format"]) if (part?.[k] !== undefined && merged[k] === undefined) merged[k] = part[k]
  }
  return merged
}
const clean = (text, max) => {
  const t = String(text ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // markdown links -> text
    .replace(/<\/?(p|br|a|b|i|em|strong|code|ul|ol|li|h[1-6]|div|span|pre|table|tr|td|th)(\s[^>]*)?\/?>/gi, "") // html tags
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t
}
const firstSentences = (text, max) => {
  const t = clean(String(text ?? "").split(/\n\s*\n/)[0], 2000)
  return t.length > max ? clean(t.slice(0, max), max) : t
}
const camel = (s) => {
  const words = String(s).split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("")
}
// LLM tool names (connector_group_verb) may be at most 64 characters: abbreviate common words, then drop middle words.
const ABBREVIATIONS = { Organization: "Org", Organizations: "Orgs", Repository: "Repo", Repositories: "Repos", Authenticated: "Auth", Permissions: "Perms", Permission: "Perm", Configuration: "Config", Configurations: "Configs", Enterprise: "Ent", Installations: "Installs", Installation: "Install", Environment: "Env", Environments: "Envs", Information: "Info", Notification: "Notif", Notifications: "Notifs", Integration: "Integ", Integrations: "Integs", Application: "App", Applications: "Apps", Subscription: "Sub", Subscriptions: "Subs", Administrator: "Admin", Administrators: "Admins", Authentication: "Authn", Authorization: "Authz", Collaborator: "Collab", Collaborators: "Collabs", Contributor: "Contrib", Contributors: "Contribs", Dependency: "Dep", Dependencies: "Deps", Vulnerability: "Vuln", Vulnerabilities: "Vulns", Management: "Mgmt", Properties: "Props", Property: "Prop", Attachment: "Attach", Attachments: "Attaches", Conversation: "Conv", Conversations: "Convs", Description: "Desc", Identifier: "Id", Specification: "Spec", Registration: "Reg", Notebook: "Nb" }
function fit(text, max) {
  if (text.length <= max) return text
  let words = text.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [text]
  words = words.map((w, i) => (i > 0 && ABBREVIATIONS[w]) || w)
  const join = (ws) => ws.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join("")
  while (join(words).length > max && words.length > 2) words.splice(1, 1)
  return join(words).slice(0, max)
}
const q = (s) => JSON.stringify(s)
const ident = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k))

// ---------------------------------------------------------------- what the connector already has by hand
const handNames = new Set()
const handSignatures = new Set()
const norm = (m, p) => `${m.toUpperCase()} ${p.replace(/\{[^}]+\}/g, "{}")}`
{
  const parts = connectorSource.split(/\n {4}"([\w.]+)": \{/)
  for (let i = 1; i < parts.length; i += 2) {
    handNames.add(parts[i])
    const m = /method:\s*"(\w+)"/.exec(parts[i + 1]), p = /path:\s*[`"]([^`"]+)[`"]/.exec(parts[i + 1])
    if (m && p) handSignatures.add(norm(m[1], p[1].replace(/\$\{[^}]+\}/g, "{x}")))
  }
}

// ---------------------------------------------------------------- base path: connector base URL vs. the spec's server
const connectorBasePath = new URL(/baseUrl:\s*"([^"]+)"/.exec(connectorSource)[1].replace(/\{[^}]+\}/g, "x")).pathname.replace(/\/$/, "")
let serverPath = ""
const computeServerPath = (def) => {
  if (def.serverPath !== undefined) return def.serverPath
  if (swagger2) return (spec.basePath ?? "").replace(/\/$/, "")
  const url = spec.servers?.[0]?.url ?? ""
  try { return new URL(url.replace(/\{[^}]+\}/g, "x")).pathname.replace(/\/$/, "") } catch { return "" }
}
const relativePath = (specPath) => {
  const full = serverPath + specPath
  if (full === connectorBasePath) return "/"
  if (!full.startsWith(connectorBasePath + "/")) return null
  return full.slice(connectorBasePath.length)
}

// ---------------------------------------------------------------- JSON Schema -> Zod source
function zodOf(schema, depth = 0) {
  schema = mergeAllOf(schema)
  if (!schema || typeof schema !== "object") return "z.unknown()"
  // Form-encoded APIs that describe a field as "a JSON string" accept the real structure when we send JSON.
  if (schema.jsonish) return "z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])"
  let base
  if (schema.enum && schema.enum.every((v) => typeof v === "string") && schema.enum.length > 0) base = `z.enum([${schema.enum.map(q).join(", ")}])`
  else if (schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string") && schema.type.length <= 2)) base = "z.string()"
  else if (schema.type === "integer" || schema.type === "number") base = "z.number()"
  else if (schema.type === "boolean") base = "z.boolean()"
  else if (schema.type === "array") base = `z.array(${zodOf(schema.items, depth + 1)})`
  else if (schema.type === "object" || schema.properties) {
    const props = Object.entries(schema.properties ?? {})
    if (props.length === 0 || depth >= 2) base = "z.record(z.string(), z.unknown())"
    else {
      const required = new Set(schema.required ?? [])
      base = `obj({ ${props.map(([k, v]) => `${ident(k)}: ${zodOf(v, depth + 1)}${required.has(k) ? "" : ".optional()"}`).join(", ")} })`
    }
  } else base = "z.unknown()"
  if (schema.nullable === true || schema["x-nullable"] === true || (Array.isArray(schema.type) && schema.type.includes("null"))) base += ".nullable()"
  return base
}

// ---------------------------------------------------------------- operations
// The kit can send scalars and arrays of scalars as query parameters, nothing deeper.
const isComplexQuery = (p) => {
  if (p.in !== "query") return false
  const sch = mergeAllOf(swagger2 ? p : p.schema)
  if (sch?.type === "object") return true
  if (sch?.type === "array") {
    const t = mergeAllOf(sch.items)?.type
    return t === "object" || t === "array"
  }
  return false
}
const METHODS = ["get", "post", "put", "patch", "delete"]
const used = new Set(handNames)
const seenSignatures = new Set() // method + path already generated from an earlier specification
const groups = new Map()
const excluded = new Set(config.exclude ?? [])
const dropParams = new Set(config.dropParams ?? [])
const skipped = { oddPath: 0, complexQuery: 0, deprecated: 0, nonJsonBody: 0, handWritten: 0, outsideBase: 0, requiredHeader: 0, noId: 0 }
async function processSpec(def) {
spec = await loadSpec(def)
swagger2 = typeof spec.swagger === "string"
serverPath = computeServerPath(def)
const ops = []
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method]
    if (!op) continue
    const rel = relativePath(path)
    if (/[\\\s]/.test(path)) { skipped.oddPath++; continue }
    if (rel === null) { skipped.outsideBase++; continue }
    if (excluded.has(`${method.toUpperCase()} ${path}`) || handSignatures.has(norm(method, rel))) { skipped.handWritten++; continue }
    if (op.deprecated) { skipped.deprecated++; continue }
    if (seenSignatures.has(norm(method, rel))) { skipped.duplicate = (skipped.duplicate ?? 0) + 1; continue }
    seenSignatures.add(norm(method, rel))
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveRef).filter(Boolean)
    // A query parameter that is an object (deepObject style) cannot be sent by the kit: skip it, or the whole operation when it is required.
    const isObj = isComplexQuery
    if (params.some((p) => isObj(p) && p.required)) { skipped.complexQuery++; continue }
    if (params.some((p) => (p.in === "header" || p.in === "cookie") && p.required && !/^(accept|content-type|authorization)$/i.test(p.name) && !(config.ignoreHeaders ?? []).includes(p.name))) { skipped.requiredHeader++; continue }

    // Normalize the request body: OpenAPI 3 requestBody, Swagger 2 `in: body` / `in: formData`.
    let bodySchema, bodyRequired = false, formFields = []
    if (swagger2) {
      const bodyParam = params.find((p) => p.in === "body")
      const consumes = op.consumes ?? spec.consumes ?? ["application/json"]
      const isJson = consumes.some((c) => c.includes("json"))
      const forms = params.filter((p) => p.in === "formData")
      if (forms.some((p) => p.type === "file")) { skipped.nonJsonBody++; continue }
      if ((forms.length > 0 || bodyParam) && !isJson && !config.formAsJson) { skipped.nonJsonBody++; continue }
      if (bodyParam) { bodySchema = bodyParam.schema; bodyRequired = bodyParam.required === true }
      formFields = forms
    } else {
      const requestBody = resolveRef(op.requestBody)
      const content = requestBody?.content
      if (content && !content["application/json"] && !(config.formAsJson && (content["application/x-www-form-urlencoded"]))) { skipped.nonJsonBody++; continue }
      const media = content?.["application/json"] ?? content?.["application/x-www-form-urlencoded"]
      bodySchema = media?.schema
      bodyRequired = requestBody?.required === true
    }
    ops.push({ path, rel, method, op, params, bodySchema, bodyRequired, formFields })
  }
}

for (const { path, rel, method, op, params: allParams, bodySchema, bodyRequired, formFields } of ops) {
  // ---- name: group.verb
  const id = String(op.operationId ?? "")
  let groupWords, verbWords
  if (config.naming === "path") {
    // For providers whose operation ids are generic or are just "method-path" (HubSpot): name from the path.
    const segs = rel.split("/").filter(Boolean)
    const isParam = (x) => x.startsWith("{")
    const isNoise = (x) => /^v\d+$/.test(x) || /^\d{4}-\d{2}(-beta)?$/.test(x) || x === "api"
    const stat = segs.filter((x) => !isParam(x) && !isNoise(x))
    const trailingParam = segs.length > 0 && isParam(segs[segs.length - 1])
    const g = stat[1] === "objects" && stat[2] ? [stat[0], stat[2]] : stat.slice(0, 2)
    groupWords = g.join(" ") || "misc"
    const tail = stat.slice(g.length === 2 && stat[1] === "objects" ? 3 : g.length)
    const prefix = { get: trailingParam ? "get" : "list", post: "create", put: "replace", patch: "update", delete: "delete" }[method]
    verbWords = `${prefix} ${tail.join(" ")}${trailingParam && !tail.length ? "" : ""}`
  }
  const sep = config.naming === "path" ? null : /^([A-Za-z0-9-]+)[/_](.+)$/.exec(id)
  if (config.naming === "path") { /* names set above */ }
  else if (sep && !/\s/.test(id)) { groupWords = sep[1]; verbWords = sep[2] }
  else {
    groupWords = op.tags?.[0] ?? rel.split("/").filter((s) => s && !s.startsWith("{"))[0] ?? "misc"
    verbWords = id || `${method}${rel.split("/").filter((s) => s && !s.startsWith("{")).slice(-2).join(" ")}`
  }
  if (config.stripFromOperationId) verbWords = verbWords.replace(new RegExp(config.stripFromOperationId, "g"), "")
  let group = camel(groupWords) || "misc"
  let verb = camel(verbWords) || method
  group = fit(group, 30)
  const maxVerb = 64 - (config.name.length + 1 + group.length + 1)
  verb = fit(verb + (def.verbSuffix ?? ""), maxVerb)
  let name = `${group}.${verb}`
  for (let n = 2; used.has(name); n++) name = `${group}.${(verb + n).length <= maxVerb ? verb + n : verb.slice(0, Math.max(1, maxVerb - String(n).length)) + n}`
  used.add(name)

  const params = allParams.filter((p) => (p.in === "path" || p.in === "query") && !dropParams.has(p.name) && !isComplexQuery(p) && (p.in !== "path" || rel.includes(`{${p.name}}`)))
  // A placeholder the specification forgot to declare is still a required string.
  for (const [, ph] of rel.matchAll(/\{(\w+)\}/g)) if (!params.some((p) => p.in === "path" && p.name === ph)) params.push({ in: "path", name: ph, required: true, schema: { type: "string" }, type: "string" })
  const fields = new Map() // input name -> { zod, required, where, wire }
  const add = (key, entry) => { if (!fields.has(key)) fields.set(key, entry) }

  // ---- pagination (config rules)
  const respSchema = (() => {
    const r = resolveRef(op.responses?.["200"] ?? op.responses?.["201"])
    const s = swagger2 ? r?.schema : Object.values(r?.content ?? {})[0]?.schema
    return mergeAllOf(s)
  })()
  let rule = null
  if (method === "get") {
    for (const r of config.pagination ?? []) {
      const need = [r.size, r.position, r.page, r.cursor].filter(Boolean)
      if (!need.every((n) => params.some((p) => p.name === n))) continue
      let itemsKey = r.itemsKey
      if (itemsKey === "auto") {
        const arrays = Object.entries(respSchema?.properties ?? {}).filter(([, v]) => mergeAllOf(v)?.type === "array").map(([k]) => k)
        if (arrays.length !== 1) continue
        itemsKey = arrays[0]
      }
      const items = itemsKey ? mergeAllOf(respSchema?.properties?.[itemsKey]) : respSchema
      if (items?.type !== "array") continue
      rule = { ...r, call: r.call.replace("{items}", itemsKey ?? "") }
      break
    }
  }
  const paged = new Set(rule ? [rule.size, rule.position, rule.page, rule.cursor].filter(Boolean) : [])

  for (const p of params) {
    if (paged.has(p.name)) continue
    const key = p.name.replace(/[^A-Za-z0-9_]/g, "_")
    const desc = derived ? "" : clean(p.description, 160)
    let zod = zodOf(swagger2 ? { type: p.type, enum: p.enum, items: p.items, format: p.format } : p.schema)
    if (desc) zod += `.describe(${q(desc)})`
    add(key, { zod, required: p.in === "path" || p.required === true, where: p.in, wire: p.name })
  }

  let wholeBody = false
  const body = mergeAllOf(bodySchema)
  const bodyProps = [...Object.entries(body?.properties ?? {}).map(([k, v]) => [k, v, (body.required ?? []).includes(k)]), ...formFields.filter((f) => !dropParams.has(f.name)).map((f) => [f.name, { jsonish: config.formAsJson && /json/i.test(f.description ?? ""), type: f.type, enum: f.enum, items: f.items, description: f.description }, f.required === true])]
  if (body || formFields.length > 0) {
    const clash = bodyProps.some(([k]) => fields.has(k.replace(/[^A-Za-z0-9_]/g, "_")))
    if ((body?.type === "object" || (!body && formFields.length > 0) || body?.properties) && bodyProps.length > 0 && !clash && !body?.oneOf && !body?.anyOf) {
      for (const [k, v, req] of bodyProps) {
        const sch = mergeAllOf(v)
        const desc = derived ? "" : clean(sch?.description, 160)
        const key = k.replace(/[^A-Za-z0-9_]/g, "_")
        add(key, { zod: zodOf(v) + (desc ? `.describe(${q(desc)})` : ""), required: req, where: "body", wire: k })
      }
    } else if (body) {
      wholeBody = true
      add("body", { zod: `${body.type === "array" ? zodOf(body) : "z.record(z.string(), z.unknown())"}.describe("The JSON request body (see the provider documentation)")`, required: bodyRequired, where: "body", wire: "body" })
    }
  }

  const entries = [...fields.entries()]
  const inputFields = entries.map(([k, f]) => `${ident(k)}: ${f.zod}${f.required ? "" : ".optional()"}`)
  if (rule) inputFields.push("cursor: z.string().optional()", "pageSize: z.number().optional()")
  const description = derived ? (() => {
    const words = (verbWords || id).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase()
    const sentence = words ? words[0].toUpperCase() + words.slice(1) : method.toUpperCase()
    const topic = op.tags?.[0] ? ` Part of: ${clean(op.tags[0], 60)}.` : ""
    return clean(`${sentence}.${topic} Calls ${method.toUpperCase()} ${rel} on ${config.title ?? config.name}.`, 480)
  })() : (() => {
    const humanized = (verbWords || id).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase()
    const summary = clean(op.summary || op.description || (humanized ? humanized[0].toUpperCase() + humanized.slice(1) : ""), 160)
    const detail = firstSentences(op.description, 330)
    let d = summary
    if (detail && !detail.toLowerCase().startsWith(summary.toLowerCase().slice(0, 20))) d += d.endsWith(".") ? ` ${detail}` : `. ${detail}`
    if (d.length < 45) d += ` Calls ${method.toUpperCase()} ${rel} on ${config.title ?? config.name}.`
    return clean(d, 480)
  })()

  const effect = method === "get" ? "read" : method === "delete" ? "destructive" : "write"
  const bodyKeys = entries.filter(([, f]) => f.where === "body")
  const queryKeys = entries.filter(([, f]) => f.where === "query")
  const lines = [
    `description: ${q(description)}`,
    `method: ${q(method.toUpperCase())}`,
    `path: ${q(rel)}`,
    `input: obj({ ${inputFields.join(", ")} })`,
    `output: ${rule ? "z.array(z.unknown())" : "z.unknown()"}`,
    `effect: ${q(effect)}`,
  ]
  if (rule) lines.push(`paginate: ${rule.call}`)
  const nameMap = (list) => `{ ${list.map(([k, f]) => `${ident(k)}: ${q(f.wire)}`).join(", ")} }`
  const identity = (list) => list.every(([k, f]) => k === f.wire)
  if ((method !== "get" && method !== "delete") || (method === "delete" && bodyKeys.length > 0)) {
    if (queryKeys.length > 0) lines.push(identity(queryKeys) ? `buildQuery: (i) => pick(i, ${q(queryKeys.map(([k]) => k))})` : `buildQuery: (i) => pickAs(i, ${nameMap(queryKeys)})`)
    if (wholeBody) lines.push("buildBody: (i) => i.body")
    else if ((queryKeys.length > 0 && bodyKeys.length > 0) || (method === "delete" && bodyKeys.length > 0)) lines.push(identity(bodyKeys) ? `buildBody: (i) => pick(i, ${q(bodyKeys.map(([k]) => k))})` : `buildBody: (i) => pickAs(i, ${nameMap(bodyKeys)})`)
    else if (bodyKeys.length > 0 && !identity(bodyKeys)) lines.push(`buildBody: (i) => pickAs(i, ${nameMap(bodyKeys)})`)
  } else if (queryKeys.some(([k, f]) => k !== f.wire)) {
    lines.push(`buildQuery: (i) => pickAs(i, ${nameMap(queryKeys)})`)
  }
  const list = groups.get(group) ?? []
  list.push(`  ${q(name)}: {\n${lines.map((l) => `    ${l},`).join("\n")}\n  },`)
  groups.set(group, list)
}
}
for (const def of specDefs) await processSpec(def)

// ---------------------------------------------------------------- write files
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const header = `// GENERATED by scripts/gen-openapi.mjs from ${specDefs.map((d) => d.url).join(", ")}\n// Source license: ${config.license}\n// Do not edit by hand: change scripts/openapi/${config.name}.json or the generator, then re-run it.\n`
const names = [...groups.keys()].sort()
for (const group of names) {
  const text = groups.get(group).join("\n")
  const imports = [`import { z } from "zod"`, `import type { ActionDefinition } from "../../../define.js"`, `import { obj } from "../../../openapi-helpers.js"`]
  if (/pickAs\(/.test(text)) imports.push(`import { pick, pickAs } from "../../../openapi-helpers.js"`)
  else if (/pick\(/.test(text)) imports.push(`import { pick } from "../../../openapi-helpers.js"`)
  const strategies = [...new Set((config.pagination ?? []).map((r) => r.import).filter((n) => text.includes(`paginate: ${n}(`)))]
  if (strategies.length > 0) imports.push(`import { ${strategies.join(", ")} } from "../../../index.js"`)
  writeFileSync(`${outDir}/${group}.ts`, `${header}${imports.join("\n")}\n\n// Annotated (not inferred) on purpose: a precise type for thousands of actions makes the compiler run out of memory.\nexport const ${group}Actions: Record<string, ActionDefinition> = {\n${text}\n}\n`)
}
writeFileSync(
  `${outDir}/index.ts`,
  `${header}${names.map((g) => `import { ${g}Actions } from "./${g}.js"`).join("\n")}\n\nexport const generatedActions = {\n${names.map((g) => `  ...${g}Actions,`).join("\n")}\n}\n`,
)
const total = [...groups.values()].reduce((n, l) => n + l.length, 0)
console.log(`${config.name}: ${total} actions in ${names.length} groups. Skipped: ${JSON.stringify(skipped)}`)
