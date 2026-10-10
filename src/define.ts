import type { ZodType } from "zod"
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
   * ADR-010: makes this a paginated action. `input` must include optional
   * `cursor: z.string()` and `pageSize: z.number()` fields — the kit reads and
   * removes them, it does not add them for you.
   */
  paginate?: PaginationStrategy
}

export interface ConnectorDefinition<A extends Record<string, ActionDefinition>> {
  name: string
  baseUrl: string
  auth: AuthConfig
  defaultHeaders?: Record<string, string>
  actions: A
}

/** Identity helper: exists so TypeScript infers the exact action names and schemas. */
export function defineConnector<const A extends Record<string, ActionDefinition>>(
  definition: ConnectorDefinition<A>,
): ConnectorDefinition<A> {
  return definition
}
