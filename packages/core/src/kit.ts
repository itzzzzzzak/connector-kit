import type { z } from "zod"
import type { ActionDefinition, ConnectorDefinition } from "./define.js"
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, execute, type Credentials } from "./execute.js"
import type { PageEnvelope, PaginationStrategy } from "./pagination.js"
import { DEFAULT_RETRY, type RetryOptions } from "./retry.js"

export interface KitOptions {
  /** Inject for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Abort a provider call after this long. Default 30 000 ms. */
  timeoutMs?: number
  /** Reject provider responses larger than this. Default 1 000 000 bytes. */
  maxResponseBytes?: number
  /** Retry policy (ADR-008). Pass `{ maxRetries: 0 }` to disable retrying. */
  retry?: Partial<RetryOptions>
}

export interface ConnectOptions {
  /** One connection = one end user's account (multi-tenant from day one). */
  connectionId: string
  credentials: Credentials
}

type ItemOf<T> = T extends readonly (infer U)[] ? U : never

/**
 * A plain action returns its parsed output. A paginated action (ADR-010) returns one
 * bounded page, { items, nextCursor } — the same shape whether the caller is an agent
 * (one call = one page) or a developer using kit.paginate() to loop over every page.
 */
export type ExecuteResult<Def extends ActionDefinition> = Def extends { paginate: PaginationStrategy }
  ? PageEnvelope<ItemOf<z.output<Def["output"]>>>
  : z.output<Def["output"]>

export interface Connection<A extends Record<string, ActionDefinition>> {
  readonly connectionId: string
  execute<K extends keyof A & string>(action: K, input: z.input<A[K]["input"]>): Promise<ExecuteResult<A[K]>>
}

/** Actions in A that declare `paginate`, i.e. the ones `paginate()` below can be used with. */
type PaginatedActionNames<A extends Record<string, ActionDefinition>> = {
  [K in keyof A & string]: A[K] extends { paginate: PaginationStrategy } ? K : never
}[keyof A & string]

export function createConnectorKit(options: KitOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...options.retry }

  return {
    connect<A extends Record<string, ActionDefinition>>(
      connector: ConnectorDefinition<A>,
      { connectionId, credentials }: ConnectOptions,
    ): Connection<A> {
      async function run<K extends keyof A & string>(action: K, input: z.input<A[K]["input"]>): Promise<ExecuteResult<A[K]>> {
        const result = await execute({
          connector,
          actionName: action,
          input,
          credentials,
          fetch: fetchImpl,
          timeoutMs,
          maxResponseBytes,
          retry,
        })
        // Safe: `execute` already built this from `action.output` (plus nextCursor, when paginated).
        return result as ExecuteResult<A[K]>
      }
      return { connectionId, execute: run }
    },

    /**
     * Developer convenience ONLY — not exposed to agents. Follows every page by
     * feeding each nextCursor back into execute(), and yields items one at a time.
     */
    async *paginate<A extends Record<string, ActionDefinition>, K extends PaginatedActionNames<A>>(
      connection: Connection<A>,
      action: K,
      input: z.input<A[K]["input"]>,
    ): AsyncGenerator<ItemOf<z.output<A[K]["output"]>>> {
      let cursor: string | undefined
      for (;;) {
        const page = (await connection.execute(action, {
          ...(input as object),
          ...(cursor !== undefined && { cursor }),
        } as z.input<A[K]["input"]>)) as PageEnvelope<
          ItemOf<z.output<A[K]["output"]>>
        >
        for (const item of page.items) yield item
        if (page.nextCursor === null) return
        cursor = page.nextCursor
      }
    },
  }
}
