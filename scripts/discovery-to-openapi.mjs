// Turns a Google API Discovery document (https://www.googleapis.com/discovery/v1/apis/<api>/<version>/rest) into an OpenAPI 3 object,
// so scripts/gen-openapi.mjs can generate a Google connector like any other. Only what the generator reads is produced: paths, the
// path and query parameters of each method, the JSON request body and the JSON response, and the shared schemas.
//   import { discoveryToOpenApi } from "./discovery-to-openapi.mjs"
//   discoveryToOpenApi(document, { stripResources: ["users"] })
// `stripResources` drops leading resource names from method names (Gmail's `users.messages.list` becomes `messages.list`).

const refName = (name) => `#/components/schemas/${name}`

function convertSchema(schema) {
  if (!schema || typeof schema !== "object") return {}
  if (schema.$ref) return { $ref: refName(schema.$ref) }
  const out = {}
  if (schema.type && schema.type !== "any") out.type = schema.type
  if (schema.format) out.format = schema.format
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (schema.type === "array") out.items = convertSchema(schema.items)
  if (schema.properties) {
    out.type = "object"
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, convertSchema(v)]))
  }
  if (schema.additionalProperties) out.additionalProperties = convertSchema(schema.additionalProperties)
  return out
}

function convertParameter(name, p) {
  const item = { type: p.type === "any" ? "string" : p.type ?? "string" }
  if (p.format) item.format = p.format
  if (p.enum) item.enum = p.enum
  const schema = p.repeated ? { type: "array", items: item } : item
  const out = { name, in: p.location === "path" ? "path" : "query", required: p.required === true || p.location === "path", schema }
  if (p.description) out.description = p.description
  return out
}

export function discoveryToOpenApi(doc, options = {}) {
  const strip = options.stripResources ?? []
  const servicePath = doc.servicePath ?? ""
  const paths = {}
  const walk = (resources, chain) => {
    for (const [resourceName, resource] of Object.entries(resources ?? {})) {
      const here = [...chain, resourceName]
      for (const [methodName, m] of Object.entries(resource.methods ?? {})) addMethod(here, methodName, m)
      walk(resource.resources, here)
    }
  }
  const addMethod = (chain, methodName, m) => {
    const named = chain.filter((c, i) => !(i < strip.length && c === strip[i]))
    const path = "/" + servicePath + m.path.replace(/\{([+#]?)(\w+)(=[^}]*)?\}/g, (_, plus, name) => `{${plus === "+" ? "+" : ""}${name}}`)
    const parameters = Object.entries(m.parameters ?? {}).map(([name, p]) => convertParameter(name, p))
    // Every Google API accepts `fields` (a partial-response mask); Drive returns almost nothing without it.
    if (!parameters.some((p) => p.name === "fields")) parameters.push({ name: "fields", in: "query", required: false, schema: { type: "string" }, description: "A field mask that limits the response to the listed fields, e.g. files(id,name)" })
    const op = {
      operationId: `${named.length > 0 ? named.join("-") : doc.name}_${methodName}`,
      tags: [named[0] ?? doc.name],
      summary: String(m.description ?? "").split(/\n\s*\n/)[0],
      description: m.description,
      parameters,
    }
    if (m.deprecated) op.deprecated = true
    if (m.request?.$ref) op.requestBody = { required: true, content: { "application/json": { schema: { $ref: refName(m.request.$ref) } } } }
    if (m.response?.$ref) op.responses = { 200: { description: "OK", content: { "application/json": { schema: { $ref: refName(m.response.$ref) } } } } }
    else op.responses = { 200: { description: "OK" } }
    paths[path] = { ...paths[path], [m.httpMethod.toLowerCase()]: op }
  }
  for (const [methodName, m] of Object.entries(doc.methods ?? {})) addMethod([], methodName, m)
  walk(doc.resources, [])
  return {
    openapi: "3.0.0",
    info: { title: doc.title, version: doc.version },
    servers: [{ url: doc.rootUrl }],
    paths,
    components: { schemas: Object.fromEntries(Object.entries(doc.schemas ?? {}).map(([k, v]) => [k, convertSchema(v)])) },
  }
}
