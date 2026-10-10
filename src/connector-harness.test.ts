// Shared helper for connector tests: a fake fetch that records requests. Not a test file itself.
import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectorKitError, createConnectorKit, type ActionDefinition, type ConnectorDefinition, type KitOptions } from "./index.js"

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

const isError = (code: string, extra?: (e: ConnectorKitError) => boolean) => (e: unknown) => e instanceof ConnectorKitError && e.code === code && (extra?.(e) ?? true)

interface StandardCase {
  /** Action name, e.g. "tasks.get". */
  action: string
  /** Valid input for it. */
  input: Record<string, unknown>
  /** A realistic success body (so the response parses). */
  ok: unknown
  /** The same input with one field set to the wrong type: must be rejected before anything is sent. Omit for an action that takes no input. */
  badInput?: Record<string, unknown>
  /** HTTP status the provider uses for "bad credentials" (almost always 401). */
  unauthorizedStatus?: number
}

/**
 * The failure-path tests EVERY connector action must have (docs/writing-connectors.md section 10), so each
 * connector's own test file can focus on what is specific to it. Call once per action.
 */
export function standardTests<A extends Record<string, ActionDefinition>>(connector: ConnectorDefinition<A>, c: StandardCase): void {
  const label = `${connector.name}.${c.action}`
  const run = (conn: { execute: (a: never, i: never) => Promise<unknown> }) => conn.execute(c.action as never, c.input as never)
  const retry = { maxRetries: 2, sleep: async () => {}, random: () => 0 }
  const effect = connector.actions[c.action]!.effect

  test(`${label}: a good response is parsed`, async () => {
    const { conn } = harness(connector, () => json(c.ok))
    await run(conn as never)
  })
  test(`${label}: 404 is not_found`, async () => {
    const { conn } = harness(connector, () => json({ message: "nope" }, 404))
    await assert.rejects(() => run(conn as never), isError("not_found"))
  })
  test(`${label}: bad credentials are auth_expired`, async () => {
    const { conn } = harness(connector, () => json({ message: "bad" }, c.unauthorizedStatus ?? 401))
    await assert.rejects(() => run(conn as never), isError("auth_expired"))
  })
  test(`${label}: 429 is rate_limited and carries Retry-After`, async () => {
    const { conn } = harness(connector, () => json({}, 429, { "retry-after": "7" }))
    await assert.rejects(() => run(conn as never), isError("rate_limited", (e) => e.retryable && e.retryAfter === 7))
  })
  test(`${label}: a malformed response is upstream_error, not a crash`, async () => {
    const { conn } = harness(connector, () => new Response("<html>not json</html>", { status: 200 }))
    await assert.rejects(() => run(conn as never), isError("upstream_error"))
  })
  if (c.badInput) {
    const badInput = c.badInput
    test(`${label}: bad input is rejected and NOTHING is sent`, async () => {
      const { conn, calls } = harness(connector, () => json(c.ok))
      await assert.rejects(() => conn.execute(c.action as never, badInput as never), isError("invalid_input"))
      assert.equal(calls.length, 0)
    })
  }
  test(`${label}: the credential is sent and never appears in an error`, async () => {
    const { conn, calls } = harness(connector, () => json({ message: "bad" }, 401), { credentials: { token: "SECRET-TOKEN-123" } })
    await assert.rejects(() => run(conn as never), (e: unknown) => !JSON.stringify(e).includes("SECRET-TOKEN-123") && !(e as Error).message.includes("SECRET-TOKEN-123"))
    assert.ok(JSON.stringify([...(calls[0]?.init.headers instanceof Headers ? calls[0].init.headers : new Headers(calls[0]?.init.headers))]).includes("SECRET-TOKEN-123"))
  })
  if (effect === "read") {
    test(`${label}: a read is retried after a 5xx`, async () => {
      let n = 0
      const { conn, calls } = harness(connector, () => (++n === 1 ? json({}, 503) : json(c.ok)), { retry })
      await run(conn as never)
      assert.equal(calls.length, 2)
    })
  } else if (!connector.actions[c.action]!.safeToRetry) {
    test(`${label}: a write is NOT retried after a 5xx (it may already have happened)`, async () => {
      const { conn, calls } = harness(connector, () => json({}, 503), { retry })
      await assert.rejects(() => run(conn as never), isError("upstream_error"))
      assert.equal(calls.length, 1)
    })
  }
}
