import type { z } from "zod"
import type { ActionDefinition, ConnectorDefinition } from "./define.js"
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, execute, type Credentials } from "./execute.js"

export interface KitOptions {
  /** Inject for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Abort a provider call after this long. Default 30 000 ms. */
  timeoutMs?: number
  /** Reject provider responses larger than this. Default 1 000 000 bytes. */
  maxResponseBytes?: number
}

export interface ConnectOptions {
  /** One connection = one end user's account (multi-tenant from day one). */
  connectionId: string
  credentials: Credentials
}

export interface Connection<A extends Record<string, ActionDefinition>> {
  readonly connectionId: string
  execute<K extends keyof A & string>(
    action: K,
    input: z.input<A[K]["input"]>,
  ): Promise<z.output<A[K]["output"]>>
}

export function createConnectorKit(options: KitOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  return {
    connect<A extends Record<string, ActionDefinition>>(
      connector: ConnectorDefinition<A>,
      { connectionId, credentials }: ConnectOptions,
    ): Connection<A> {
      async function run<K extends keyof A & string>(
        action: K,
        input: z.input<A[K]["input"]>,
      ): Promise<z.output<A[K]["output"]>> {
        const result = await execute({
          connector,
          actionName: action,
          input,
          credentials,
          fetch: fetchImpl,
          timeoutMs,
          maxResponseBytes,
        })
        // Safe: `execute` already parsed the result with this action's own output schema.
        return result as z.output<A[K]["output"]>
      }
      return { connectionId, execute: run }
    },
  }
}
