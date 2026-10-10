// Shared helper for connector tests: a fake fetch that records requests. Not a test file itself.
import { createConnectorKit, type ActionDefinition, type ConnectorDefinition, type KitOptions } from "./index.js"

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

export interface Call {
  url: URL
  init: RequestInit
  /** The JSON body, when there is one. */
  body: unknown
  header(name: string): string | null
}

/**
 * Connect `connector` to a fake provider. `respond` decides each answer; every request is recorded.
 * Retries are off unless you pass `options.retry`.
 */
export function harness<A extends Record<string, ActionDefinition>>(
  connector: ConnectorDefinition<A>,
  respond: (call: Call) => Response | Promise<Response>,
  options: KitOptions & { credentials?: { token: string } } = {},
) {
  const calls: Call[] = []
  const { credentials = { token: "test-token" }, ...kitOptions } = options
  const kit = createConnectorKit({
    retry: { maxRetries: 0 },
    ...kitOptions,
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      let body: unknown
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: Call = { url: new URL(String(input)), init: init ?? {}, body, header: (name) => headers.get(name) }
      calls.push(call)
      return respond(call)
    }) as typeof fetch,
  })
  return { kit, calls, conn: kit.connect(connector, { connectionId: "test", credentials }) }
}
