// GraphQL support (ADR-021): a helper that turns a query into an action, and a mapper from GraphQL errors to the kit's error codes.
import type { ZodType } from "zod"
import type { ActionDefinition, Effect } from "./define.js"
import { ConnectorKitError } from "./errors.js"
import { relayPagination } from "./pagination.js"

const dig = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined), value)

/**
 * One GraphQL query or mutation as an action. `field` is the root field the document asks for: the result is `data.<field>`.
 * The input's fields are the document's variables, by name. For a list that follows Relay paging, pass `connection` (the path to it
 * under `data`) and declare `$first: Int` and `$after: String` in the document; the kit then manages both and the action is paginated.
 */
export function graphqlAction(definition: {
  description: string
  query: string
  /** The root field whose value is the result, e.g. "issue". */
  field: string
  input: ZodType
  /** For a paginated action: z.array(item), as for any paginated action. */
  output: ZodType
  effect: Effect
  /** Where the connection is under `data`, when this is a paginated list. Default: not paginated. */
  connection?: string[]
  /** Path of the endpoint under the connector's base URL. Default "/graphql". */
  path?: string
}): ActionDefinition {
  return {
    description: definition.description,
    method: "POST",
    path: definition.path ?? "/graphql",
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    graphql: definition.query,
    extract: (body) => dig(body, ["data", definition.field]),
    ...(definition.connection !== undefined && { paginate: relayPagination({ connection: definition.connection }) }),
  }
}

interface GraphqlError {
  message?: unknown
  extensions?: { code?: unknown; type?: unknown }
}

/**
 * Map a GraphQL response that carries `errors` to a ConnectorKitError, or undefined when it has none. Use it as `detectError` (a failed
 * query often comes back as HTTP 200). The code is read from `extensions.code` or `extensions.type`. Only a short code ever reaches the
 * message; the provider's text stays in `raw`. Partial results (data next to errors) count as failures: a half answer is worse than none.
 */
export function detectGraphqlError(body: unknown, status = 200): ConnectorKitError | undefined {
  const errors = dig(body, ["errors"])
  if (!Array.isArray(errors) || errors.length === 0) return undefined
  const first = errors[0] as GraphqlError
  const tag = String(first.extensions?.code ?? first.extensions?.type ?? "").toLowerCase().replace(/[^a-z]/g, "")
  const text = typeof first.message === "string" ? first.message : ""
  const raw = { status, body: JSON.stringify(errors).slice(0, 2000) }
  const init = (retryable: boolean) => ({ retryable, status, raw })
  if (/auth|unauthor/.test(tag)) return new ConnectorKitError("auth_expired", "The credentials were rejected. They may be expired or revoked.", init(false))
  if (/forbidden|permission|featurenotaccessible/.test(tag)) return new ConnectorKitError("forbidden", "The credentials are valid but not allowed to do this. Check scopes or permissions.", init(false))
  if (/rate/.test(tag)) return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", init(true))
  if (/notfound/.test(tag) || /^entity not found|not found/i.test(text)) return new ConnectorKitError("not_found", "The requested resource was not found, or the credentials cannot see it.", init(false))
  if (/invalid|input|validation|baduser|usererror/.test(tag)) return new ConnectorKitError("invalid_input", "The provider rejected the request as invalid.", init(false))
  return new ConnectorKitError("upstream_error", "The provider returned a GraphQL error.", init(false))
}
