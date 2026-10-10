import type { z } from "zod"
import type { ActionDefinition, ConnectorDefinition } from "./define.js"
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, execute, staticTokenSource, type Credentials, type TokenSource } from "./execute.js"
import { credentialKey, finishAuth, oauthConfigOf, oauthTokenSource, startAuth, type OAuthClientConfig, type OAuthDeps } from "./oauth.js"
import type { PageEnvelope, PaginationStrategy } from "./pagination.js"
import type { BeforeExecute } from "./policy.js"
import { DEFAULT_RETRY, type RetryOptions } from "./retry.js"
import type { TokenStore } from "./store.js"
import { toTools, type Tool, type ToolsOptions } from "./tools.js"

export interface KitOptions {
  /** Inject for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Abort a provider call after this long. Default 30 000 ms. */
  timeoutMs?: number
  /** Reject provider responses larger than this. Default 1 000 000 bytes. */
  maxResponseBytes?: number
  /** Retry policy (ADR-008). Pass `{ maxRetries: 0 }` to disable retrying. */
  retry?: Partial<RetryOptions>
  /** Host policy hook (ADR-007). Without it, every action runs. */
  beforeExecute?: BeforeExecute
  /**
   * Where OAuth connections live (ADR-014). Required for startAuth/finishAuth and for `connect()` without
   * `credentials`. Wrap it in `encryptedStore()` in production.
   */
  tokenStore?: TokenStore
  /** Your OAuth app per connector, keyed by connector name (e.g. `{ github: { clientId, clientSecret, redirectUri } }`). */
  oauth?: Record<string, OAuthClientConfig>
  /** Inject a clock for tests. Defaults to Date.now. */
  now?: () => number
}

export interface ConnectOptions {
  /** One connection = one end user's account (multi-tenant from day one). */
  connectionId: string
  /**
   * A fixed token (e.g. a personal access token). Omit it for an OAuth connector to use the token
   * stored for this `connectionId` by `finishAuth()`, refreshed automatically.
   */
  credentials?: Credentials
}

export interface StartAuthOptions {
  connectionId: string
  /** Override the connector's default scopes for this connection. */
  scopes?: string[]
}

export interface FinishAuthOptions {
  /** `code` and `state` from the provider's redirect to YOUR callback route. */
  code: string
  state: string
  /** Pass the logged-in user's connectionId: a login started for someone else is rejected. */
  expectedConnectionId?: string
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
  readonly connector: ConnectorDefinition<A>
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
  const now = options.now ?? Date.now

  type AnyConnector = ConnectorDefinition<Record<string, ActionDefinition>>
  /** Everything OAuth needs, or a developer-facing error saying what to configure. */
  function oauthDeps(connector: AnyConnector): OAuthDeps {
    oauthConfigOf(connector)
    if (!options.tokenStore) throw new Error('OAuth needs a store: pass createConnectorKit({ tokenStore: memoryTokenStore() }) (wrap it in encryptedStore() in production).')
    const client = options.oauth?.[connector.name]
    if (!client) throw new Error(`No OAuth app configured for "${connector.name}": pass createConnectorKit({ oauth: { ${connector.name}: { clientId, clientSecret, redirectUri } } }).`)
    return { store: options.tokenStore, fetch: fetchImpl, timeoutMs, now, client }
  }

  return {
    connect<A extends Record<string, ActionDefinition>>(
      connector: ConnectorDefinition<A>,
      { connectionId, credentials }: ConnectOptions,
    ): Connection<A> {
      let tokens: TokenSource
      if (credentials) {
        tokens = staticTokenSource(credentials.token)
      } else if (connector.auth.type === "oauth2") {
        tokens = oauthTokenSource(oauthDeps(connector as unknown as AnyConnector), connector as unknown as AnyConnector, connectionId)
      } else {
        throw new Error(`Connector "${connector.name}" needs credentials: connect(connector, { connectionId, credentials: { token } }).`)
      }

      async function run<K extends keyof A & string>(action: K, input: z.input<A[K]["input"]>): Promise<ExecuteResult<A[K]>> {
        const result = await execute({
          connector,
          actionName: action,
          input,
          connectionId,
          ...(options.beforeExecute && { beforeExecute: options.beforeExecute }),
          tokens,
          fetch: fetchImpl,
          timeoutMs,
          maxResponseBytes,
          retry,
        })
        // Safe: `execute` already built this from `action.output` (plus nextCursor, when paginated).
        return result as ExecuteResult<A[K]>
      }
      return { connectionId, connector, execute: run }
    },

    /**
     * Step 1 of connecting a user's account: returns the provider URL to redirect them to. Needs
     * `tokenStore` and `oauth` options. The kit runs no server (ADR-006): your app hosts the callback.
     */
    async startAuth<A extends Record<string, ActionDefinition>>(connector: ConnectorDefinition<A>, startOptions: StartAuthOptions): Promise<{ url: string; state: string }> {
      const c = connector as unknown as AnyConnector
      return startAuth(oauthDeps(c), c, startOptions) // async: configuration errors reject instead of throwing synchronously
    },

    /** Step 2, in your callback route: exchanges the code and stores the user's tokens. */
    async finishAuth<A extends Record<string, ActionDefinition>>(connector: ConnectorDefinition<A>, finishOptions: FinishAuthOptions): Promise<{ connectionId: string; scope?: string }> {
      const c = connector as unknown as AnyConnector
      return finishAuth(oauthDeps(c), c, finishOptions)
    },

    /** Forget a user's stored tokens. (Does not revoke them at the provider.) */
    async disconnect<A extends Record<string, ActionDefinition>>(connector: ConnectorDefinition<A>, disconnectOptions: { connectionId: string }): Promise<void> {
      if (!options.tokenStore) throw new Error("disconnect() needs a tokenStore.")
      await options.tokenStore.delete(credentialKey(connector.name, disconnectOptions.connectionId))
    },

    /** Turn a connection's actions into LLM tool definitions (ADR-011). */
    toTools<A extends Record<string, ActionDefinition>>(connection: Connection<A>, toolsOptions?: ToolsOptions): Tool[] {
      return toTools(connection, toolsOptions)
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
