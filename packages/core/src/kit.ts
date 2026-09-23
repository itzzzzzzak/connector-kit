import type { z } from "zod"
import type { ActionDefinition, ConnectorDefinition } from "./define.js"
import { execute, type Credentials } from "./execute.js"

export interface KitOptions {
  /** Inject for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
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

  return {
    connect<A extends Record<string, ActionDefinition>>(
      connector: ConnectorDefinition<A>,
      { connectionId, credentials }: ConnectOptions,
    ): Connection<A> {
      return {
        connectionId,
        execute: async (action, input) =>
          (await execute({
            connector,
            actionName: action,
            input,
            credentials,
            fetch: fetchImpl,
          })) as never,
      }
    },
  }
}
