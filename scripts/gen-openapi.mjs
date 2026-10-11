// Generates a connector's action list from a provider's OFFICIAL OpenAPI description:
//   node scripts/gen-openapi.mjs scripts/openapi/github.json [--spec path/to/local/spec.json]
// Output: src/connectors/<name>/generated/<group>.ts (one file per group) + generated/index.ts. The output is plain,
// reviewable TypeScript that is committed; this script is only run when the provider's API changes.
// Inputs are typed from the spec (path, query and top-level body fields). Responses are left open (z.unknown()), because
// the spec's response schemas are large and wrong in small ways; a hand-written action can always take precedence.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const [configPath, ...rest] = process.argv.slice(2)
if (!configPath) {
  console.error("Usage: node scripts/gen-openapi.mjs <config.json> [--spec local.json]")
  process.exit(2)
}
const config = JSON.parse(readFileSync(configPath, "utf8"))
const localSpec = rest[0] === "--spec" ? rest[1] : undefined
const spec = JSON.parse(localSpec ? readFileSync(localSpec, "utf8") : await (await fetch(config.spec)).text())
const outDir = `src/connectors/${config.name}/generated`

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
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t
}
const firstSentences = (text, max) => {
  const t = clean(String(text ?? "").split(/\n\s*\n/)[0], 2000)
  return t.length > max ? clean(t.slice(0, max), max) : t
}
// LLM tool names (connector_group_verb) may be at most 64 characters: abbreviate common words, then drop middle words.
const ABBREVIATIONS = { Organization: "Org", Organizations: "Orgs", Repository: "Repo", Repositories: "Repos", Authenticated: "Auth", Permissions: "Perms", Permission: "Perm", Configuration: "Config", Enterprise: "Ent", Installations: "Installs", Installation: "Install", Environment: "Env", Environments: "Envs", Information: "Info", Notification: "Notif", Notifications: "Notifs", Integration: "Integ", Integrations: "Integs", Application: "App", Applications: "Apps", Subscription: "Sub", Subscriptions: "Subs", Administrator: "Admin", Administrators: "Admins", Authentication: "Authn", Authorization: "Authz", Collaborator: "Collab", Collaborators: "Collabs", Contributor: "Contrib", Contributors: "Contribs", Repositorys: "Repos", Dependency: "Dep", Dependencies: "Deps", Vulnerability: "Vuln", Vulnerabilities: "Vulns", Organizations_: "Orgs" }
function fitVerb(connector, group, verb) {
  const max = 64 - (connector.length + 1 + group.length + 1)
  if (verb.length <= max) return verb
  let words = verb.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [verb]
  words = words.map((w, i) => (i > 0 && ABBREVIATIONS[w]) || w)
  const join = (ws) => ws.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join("")
  while (join(words).length > max && words.length > 2) words.splice(1, 1)
  return join(words).slice(0, max)
}
const q = (s) => JSON.stringify(s)
const camel = (s) => s.replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase())

// ---------------------------------------------------------------- JSON Schema -> Zod source
function zodOf(schema, depth = 0) {
  schema = mergeAllOf(schema)
  if (!schema || typeof schema !== "object") return "z.unknown()"
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
      const body = props.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${zodOf(v, depth + 1)}${required.has(k) ? "" : ".optional()"}`)
      base = `z.object({ ${body.join(", ")} })`
    }
  } else base = "z.unknown()"
  if (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"))) base += ".nullable()"
  return base
}

// ---------------------------------------------------------------- operations
const excluded = new Set(config.exclude ?? [])
const skipped = { deprecated: 0, nonJsonBody: 0, excluded: 0, noId: 0 }
const ops = []
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item[method]
    if (!op) continue
    if (excluded.has(`${method.toUpperCase()} ${path}`)) { skipped.excluded++; continue }
    if (op.deprecated) { skipped.deprecated++; continue }
    if (!op.operationId) { skipped.noId++; continue }
    const content = resolveRef(op.requestBody)?.content
    if (content && !content["application/json"]) { skipped.nonJsonBody++; continue }
    ops.push({ path, method, op, shared: item.parameters ?? [], bodySchema: content?.["application/json"]?.schema })
  }
}

const used = new Set()
const groups = new Map()
for (const { path, method, op, shared, bodySchema } of ops) {
  const [g, ...restId] = op.operationId.split("/")
  const group = camel(restId.length ? g : (op.tags?.[0] ?? "misc")) || "misc"
  let verb = camel(restId.length ? restId.join("-") : g)
  if (!verb) verb = method
  verb = fitVerb(config.name, group, verb)
  let name = `${group}.${verb}`
  for (let n = 2; used.has(name); n++) name = `${group}.${verb.slice(0, verb.length - String(n).length)}${n}`
  used.add(name)

  const params = [...shared, ...(op.parameters ?? [])].map(resolveRef).filter((p) => p && (p.in === "path" || p.in === "query"))
  const fields = new Map() // input name -> { zod, required, where: "path"|"query"|"body", wire }
  const add = (key, entry) => { if (!fields.has(key)) fields.set(key, entry); return fields.has(key) && fields.get(key) === entry }
  let paginated = false
  const pageSize = config.pageParams?.size
  const pageNum = config.pageParams?.page
  const respSchema = resolveRef(Object.values(resolveRef(op.responses?.["200"])?.content ?? {})[0]?.schema)
  if (method === "get" && pageSize && params.some((p) => p.name === pageSize) && params.some((p) => p.name === pageNum) && respSchema?.type === "array") paginated = true

  for (const p of params) {
    if (paginated && (p.name === pageSize || p.name === pageNum)) continue
    const key = p.name.replace(/[^A-Za-z0-9_]/g, "_")
    const desc = clean(resolveRef(p).description, 160)
    const schema = resolveRef(p.schema)
    let zod = zodOf(schema)
    if (schema?.default !== undefined && ["string", "number", "boolean"].includes(typeof schema.default) && p.in !== "path") { /* defaults are applied by the provider */ }
    if (desc) zod += `.describe(${q(desc)})`
    add(key, { zod, required: p.in === "path" || p.required === true, where: p.in, wire: p.name })
  }

  let wholeBody = false
  const body = mergeAllOf(bodySchema)
  if (body) {
    const props = Object.entries(body.properties ?? {})
    const clash = props.some(([k]) => fields.has(k))
    if (body.type === "object" && props.length > 0 && !clash && !body.oneOf && !body.anyOf) {
      const required = new Set(body.required ?? [])
      for (const [k, v] of props) {
        const sch = mergeAllOf(v)
        const desc = clean(sch?.description, 160)
        add(k, { zod: zodOf(v) + (desc ? `.describe(${q(desc)})` : ""), required: required.has(k), where: "body", wire: k })
      }
    } else {
      wholeBody = true
      add("body", { zod: `${body.type === "array" ? zodOf(body) : "z.record(z.string(), z.unknown())"}.describe("The JSON request body (see the provider documentation)")`, required: resolveRef(op.requestBody)?.required === true, where: "body", wire: "body" })
    }
  }

  const entries = [...fields.entries()]
  const inputFields = entries.map(([k, f]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${f.zod}${f.required ? "" : ".optional()"}`)
  if (paginated) inputFields.push("cursor: z.string().optional()", "pageSize: z.number().optional()")
  const description = (() => {
    const summary = clean(op.summary, 160)
    const detail = firstSentences(op.description, 330)
    let d = summary
    if (detail && !detail.toLowerCase().startsWith(summary.toLowerCase().slice(0, 20))) d += d.endsWith(".") ? ` ${detail}` : `. ${detail}`
    if (d.length < 30) d += ` (${method.toUpperCase()} ${path})`
    if (method !== "get" && !/\bdelete|remov|revok|cancel/i.test(d) && method === "delete") d += " Destroys data."
    return clean(d, 480)
  })()

  const effect = method === "get" ? "read" : method === "delete" ? "destructive" : "write"
  const bodyKeys = entries.filter(([, f]) => f.where === "body")
  const queryKeys = entries.filter(([, f]) => f.where === "query")
  const lines = [
    `description: ${q(description)}`,
    `method: ${q(method.toUpperCase())}`,
    `path: ${q(path)}`,
    `input: z.object({ ${inputFields.join(", ")} })`,
    `output: ${paginated ? "z.array(z.unknown())" : "z.unknown()"}`,
    `effect: ${q(effect)}`,
  ]
  if (paginated) lines.push(`paginate: ${config.paginationCall}`)
  const nameMap = (list) => `{ ${list.map(([k, f]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${q(f.wire)}`).join(", ")} }`
  const identity = (list) => list.every(([k, f]) => k === f.wire)
  if (method !== "get" && method !== "delete" || (method === "delete" && bodyKeys.length > 0)) {
    if (queryKeys.length > 0) lines.push(identity(queryKeys) ? `buildQuery: (i) => pick(i, ${q(queryKeys.map(([k]) => k))})` : `buildQuery: (i) => pickAs(i, ${nameMap(queryKeys)})`)
    if ((queryKeys.length > 0 && bodyKeys.length > 0) || (method === "delete" && !wholeBody)) lines.push(wholeBody ? "buildBody: (i) => i.body" : identity(bodyKeys) ? `buildBody: (i) => pick(i, ${q(bodyKeys.map(([k]) => k))})` : `buildBody: (i) => pickAs(i, ${nameMap(bodyKeys)})`)
    else if (wholeBody) lines.push("buildBody: (i) => i.body")
  } else if (queryKeys.some(([k, f]) => k !== f.wire)) {
    lines.push(`buildQuery: (i) => pickAs(i, ${nameMap(queryKeys)})`)
  }
  const list = groups.get(group) ?? []
  list.push(`  ${q(name)}: {\n${lines.map((l) => `    ${l},`).join("\n")}\n  },`)
  groups.set(group, list)
}

// ---------------------------------------------------------------- write files
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const header = `// GENERATED by scripts/gen-openapi.mjs from ${config.spec}\n// Source license: ${config.license}\n// Do not edit by hand: change scripts/openapi/${config.name}.json or the generator, then re-run it.\n`
const names = [...groups.keys()].sort()
for (const group of names) {
  const imports = [`import { z } from "zod"`, `import type { ActionDefinition } from "../../../define.js"`]
  const text = groups.get(group).join("\n")
  if (/pickAs\(/.test(text)) imports.push(`import { pick, pickAs } from "../../../openapi-helpers.js"`)
  else if (/pick\(/.test(text)) imports.push(`import { pick } from "../../../openapi-helpers.js"`)
  if (/paginate:/.test(text)) imports.push(`import { ${config.paginationImport} } from "../../../index.js"`)
  writeFileSync(`${outDir}/${group}.ts`, `${header}${imports.join("\n")}\n\nexport const ${group}Actions = {\n${text}\n} satisfies Record<string, ActionDefinition>\n`)
}
writeFileSync(
  `${outDir}/index.ts`,
  `${header}${names.map((g) => `import { ${g}Actions } from "./${g}.js"`).join("\n")}\n\nexport const generatedActions = {\n${names.map((g) => `  ...${g}Actions,`).join("\n")}\n}\n`,
)
const total = [...groups.values()].reduce((n, l) => n + l.length, 0)
console.log(`${config.name}: ${total} actions in ${names.length} groups. Skipped: ${JSON.stringify(skipped)}`)
