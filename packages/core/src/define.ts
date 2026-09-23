import type { ZodType } from "zod"

// ADR-007: every action declares how dangerous it is. The host decides policy.
export type Effect = "read" | "write" | "destructive"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type AuthConfig =
  | { type: "bearer" }
  | { type: "apiKey"; header: string; prefix?: string }

/** Description of one operation. Says WHAT; the runtime decides HOW. */
export interface ActionDefinition {
  /** Written for an LLM: when should this be used? */
  description: string
  method: HttpMethod
  /** Path template, e.g. "/repos/{owner}/{name}". {params} are filled from the input. */
  path: string
  input: ZodType
  output: ZodType
  effect: Effect
  /** ADR-008: only retry non-idempotent calls when this is true. */
  safeToRetry?: boolean
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
