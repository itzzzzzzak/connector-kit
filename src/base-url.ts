import type { ConnectorVariable } from "./define.js"

/**
 * Base URLs that depend on the account (https://{subdomain}.zendesk.com, https://api.{site}) are written as a
 * template with {placeholders} and filled in by the HOST when it connects. This is the one place a value could
 * redirect a token to a different server, so the rules are strict (ADR-017):
 *  - a value must match its declared pattern (default: a single DNS label) or be one of a declared list;
 *  - the template's fixed domain (".zendesk.com") always survives, so no value can change which domain is called;
 *  - a template that ends in a placeholder is only allowed with a closed list of values;
 *  - the result must be https with no userinfo and no port.
 * Errors are thrown to the developer (it is host configuration), never produced from model input.
 */

export const DEFAULT_VARIABLE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

export const placeholdersOf = (template: string): string[] => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)

/** The host part of a URL template: everything between "://" and the first "/". */
export const hostPartOf = (template: string): string => template.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? ""

/** What follows the last placeholder in the host, e.g. ".zendesk.com". Empty when the host ends with a placeholder. */
export const fixedHostSuffix = (template: string): string => {
  const host = hostPartOf(template)
  const lastClose = host.lastIndexOf("}")
  return lastClose === -1 ? host : host.slice(lastClose + 1)
}

export function variableMatches(spec: ConnectorVariable, value: unknown): boolean {
  if (typeof value !== "string") return false
  if (spec.values) return spec.values.includes(value)
  const pattern = spec.pattern ? new RegExp(`^(?:${spec.pattern})$`) : DEFAULT_VARIABLE_PATTERN
  return pattern.test(value)
}

const show = (value: unknown) => JSON.stringify(typeof value === "string" ? value.slice(0, 40) : typeof value)

export function resolveBaseUrl(
  connectorName: string,
  template: string,
  declared: Record<string, ConnectorVariable> | undefined,
  given: Record<string, string> | undefined,
): string {
  const names = placeholdersOf(template)
  const givenNames = Object.keys(given ?? {})

  if (names.length === 0) {
    if (givenNames.length > 0) throw new Error(`Connector "${connectorName}" takes no variables (got ${givenNames.join(", ")}).`)
    return template
  }

  const missing = names.filter((n) => given?.[n] === undefined)
  if (missing.length > 0) {
    const what = missing.map((n) => `${n} (${declared?.[n]?.description ?? "see the connector"}, e.g. "${declared?.[n]?.example ?? "..."}")`).join("; ")
    throw new Error(`Connector "${connectorName}" needs variables: ${what}. Pass connect(connector, { connectionId, variables: { ${missing.join(": ..., ")}: ... } }).`)
  }
  const unknown = givenNames.filter((n) => !names.includes(n))
  if (unknown.length > 0) throw new Error(`Connector "${connectorName}" has no variable named ${unknown.join(", ")} (it has: ${names.join(", ")}).`)

  let resolved = template
  for (const name of names) {
    const spec = declared?.[name]
    if (!spec) throw new Error(`Connector "${connectorName}" uses {${name}} in its baseUrl but does not declare it in "variables".`)
    const value = given![name]
    if (!variableMatches(spec, value)) {
      const expected = spec.values ? `one of: ${spec.values.join(", ")}` : spec.pattern ? `matching ${spec.pattern}` : "letters, digits and hyphens only"
      throw new Error(`Variable "${name}" for connector "${connectorName}" is not valid (${expected}); got ${show(value)}.`)
    }
    resolved = resolved.replaceAll(`{${name}}`, value as string)
  }

  const url = new URL(resolved)
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new Error(`Connector "${connectorName}" resolved to a base URL that is not plain https.`)
  }
  const suffix = fixedHostSuffix(template)
  if (suffix !== "" && !url.hostname.endsWith(suffix)) {
    throw new Error(`Connector "${connectorName}": a variable tried to change the domain (expected the host to end with ${suffix}).`)
  }
  return resolved
}
