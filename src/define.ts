import type { ZodType } from "zod"
import type { ConnectorKitError } from "./errors.js"
import type { PaginationStrategy } from "./pagination.js"

// ADR-007: every action declares how dangerous it is. The host decides policy.
export type Effect = "read" | "write" | "destructive"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type AuthConfig =
  | { type: "bearer" }
  | { type: "apiKey"; header: string; prefix?: string }
  /**
   * OAuth 2.0 authorization-code flow (ADR-014). Calls are sent as `Authorization: Bearer <token>`,
   * where the token comes from the TokenStore (refreshed when needed) or from static `credentials`
   * passed to `connect()` (e.g. a personal access token).
   */
  | {
      type: "oauth2"
      authorizeUrl: string
      tokenUrl: string
      /** Default scopes for startAuth(); the host may override per connection. */
      scopes?: string[]
      /** Default " ". Some providers use ",". */
      scopeSeparator?: string
      /** PKCE (S256). Default true. */
      pkce?: boolean
      /** How the client authenticates at the token endpoint. Default "body". */
      clientAuth?: "body" | "basic"
      /** Extra query params for the authorize URL (e.g. { access_type: "offline" }). */
      authorizeParams?: Record<string, string>
    }

/** Description of one operation. Says WHAT; the runtime decides HOW. */
export interface ActionDefinition {
  /** Written for an LLM: when should this be used? */
  description: string
  method: HttpMethod
  /** Path template, e.g. "/repos/{owner}/{name}". {params} are filled from the input. */
  path: string
  input: ZodType
  /**
   * For a paginated action, this is the schema of ONE ITEM's array, i.e. z.array(item) —
   * execute() wraps it as { items, nextCursor }. See ADR-010.
   */
  output: ZodType
  effect: Effect
  /** ADR-008: only retry non-idempotent calls when this is true. */
  safeToRetry?: boolean
  /**
   * Shape the JSON request body from the validated input (path parameters already removed). Default: the
   * input itself. For APIs that wrap bodies, e.g. Asana's `{ "data": { ... } }`.
   */
  buildBody?: (input: Record<string, unknown>) => unknown
  /**
   * Shape the query string from the validated input (path parameters, and for paginated actions the cursor and
   * page size, already removed). Return the parameters to send; array values are sent as repeated parameters.
   * For APIs with their own conventions, e.g. Airtable's `fields[]=a` and `sort[0][field]=Name`.
   */
  buildQuery?: (input: Record<string, unknown>) => Record<string, unknown>
  /**
   * ADR-010: makes this a paginated action. `input` must include optional
   * `cursor: z.string()` and `pageSize: z.number()` fields — the kit reads and
   * removes them, it does not add them for you.
   */
  paginate?: PaginationStrategy
}

/**
 * How much we can vouch for a connector.
 * - "live-tested": its actions were run against the real API with a real account.
 * - "docs-based": written from the provider's official documentation and tested against a fake server,
 *   but NOT run against the real service. It may have small mistakes; please report them.
 */
export type ConnectorStatus = "live-tested" | "docs-based"

/** Catalog information. Built-in connectors must have it; the conformance check enforces that. */
export interface ConnectorMeta {
  /** Display name, e.g. "GitHub". */
  title: string
  /** One sentence: what an agent or app can do with it. */
  description: string
  /** The provider's official API documentation. */
  docsUrl: string
  status: ConnectorStatus
  /** Environment variable `connector-kit-mcp` reads the credential from, e.g. "GITHUB_TOKEN". */
  credentialEnv: string
}

export interface ConnectorDefinition<A extends Record<string, ActionDefinition>> {
  name: string
  baseUrl: string
  auth: AuthConfig
  meta?: ConnectorMeta
  defaultHeaders?: Record<string, string>
  /**
   * For providers that answer HTTP 200 even when the call failed (Slack: `{ "ok": false, "error": "..." }`).
   * Called with the parsed body of every 2xx response; return a ConnectorKitError to fail the call with the
   * right code, or undefined when the body is fine. Retries and token refresh then work as for any other error
   * (see ADR-015).
   */
  detectError?: (body: unknown) => ConnectorKitError | undefined
  actions: A
}

/** Identity helper: exists so TypeScript infers the exact action names and schemas. */
export function defineConnector<const A extends Record<string, ActionDefinition>>(
  definition: ConnectorDefinition<A>,
): ConnectorDefinition<A> {
  return definition
}
