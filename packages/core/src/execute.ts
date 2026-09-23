import { ConnectorKitError, errorFromStatus } from "./errors.js"
import type { ActionDefinition, AuthConfig, ConnectorDefinition } from "./define.js"

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
/** How much of an error body we keep in ConnectorKitError.raw. */
const RAW_BODY_LIMIT_CHARS = 2_000
/** Error bodies are read with this small cap so a huge error page cannot hurt us. */
const ERROR_BODY_READ_BYTES = 8_192

export interface Credentials {
  token: string
}

export interface ExecuteParams {
  connector: ConnectorDefinition<Record<string, ActionDefinition>>
  actionName: string
  input: unknown
  credentials: Credentials
  fetch: typeof fetch
  timeoutMs: number
  maxResponseBytes: number
}

const invalid = (message: string): ConnectorKitError =>
  new ConnectorKitError("invalid_input", message, { retryable: false })

function applyAuth(headers: Headers, auth: AuthConfig, credentials: Credentials): void {
  if (auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${credentials.token}`)
  } else {
    headers.set(auth.header, `${auth.prefix ?? ""}${credentials.token}`)
  }
}

type Scalar = string | number | boolean | bigint

function isScalar(value: unknown): value is Scalar {
  return ["string", "number", "boolean", "bigint"].includes(typeof value)
}

/**
 * Fill {params} in the path from the input; return the path and the leftover fields.
 * Path values come from untrusted input (a model), so they must not be able to change
 * WHICH endpoint is called: "." and ".." are collapsed by URL parsing and would escape the path.
 */
function fillPath(template: string, input: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
  const rest = { ...input }
  const path = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = rest[key]
    if (value === undefined || value === null) {
      throw invalid(`Missing required path parameter "${key}".`)
    }
    if (!isScalar(value)) {
      throw invalid(`Path parameter "${key}" must be a string, number or boolean.`)
    }
    const text = String(value)
    if (text === "" || text === "." || text === "..") {
      throw invalid(`Path parameter "${key}" has an invalid value.`)
    }
    delete rest[key]
    return encodeURIComponent(text)
  })
  return { path, rest }
}

/** Scalars become one param, arrays of scalars become repeated params, anything else is a caller bug. */
function appendQuery(url: URL, rest: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item instanceof Date) {
        url.searchParams.append(key, item.toISOString())
      } else if (isScalar(item)) {
        url.searchParams.append(key, String(item))
      } else {
        throw invalid(`Parameter "${key}" cannot be sent as a query parameter (use scalars or arrays of scalars).`)
      }
    }
  }
}

/** Retry-After may be seconds or an HTTP date. Falls back to x-ratelimit-reset (epoch seconds) when exhausted. */
function parseRetryAfter(headers: Headers, rateLimitExhausted: boolean): number | undefined {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  }
  if (rateLimitExhausted) {
    const reset = Number(headers.get("x-ratelimit-reset"))
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000))
  }
  return undefined
}

/** Read at most maxBytes. Never buffers an unbounded body. */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { text, truncated: true }
    }
    text += decoder.decode(value, { stream: true })
  }
  return { text: text + decoder.decode(), truncated: false }
}

/** Timeouts and dropped connections. Deliberately no cause/URL details: keep secrets and internals out of errors. */
function networkError(error: unknown, timeoutMs: number): ConnectorKitError {
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") {
    return new ConnectorKitError("upstream_error", `The provider did not respond within ${timeoutMs} ms.`, { retryable: true })
  }
  return new ConnectorKitError("upstream_error", "Could not reach the provider (network error).", { retryable: true })
}

/**
 * The single choke point (see docs/notebook.md): validate → auth → HTTP → normalize.
 * Retries, rate limiting and the beforeExecute hook will be added here, not around it.
 */
export async function execute(params: ExecuteParams): Promise<unknown> {
  const { connector, actionName, credentials } = params
  const action = connector.actions[actionName]
  if (!action) {
    throw invalid(`Unknown action "${actionName}" on connector "${connector.name}".`)
  }

  // 1. Validate BEFORE any network call. Agents hallucinate arguments.
  const parsed = action.input.safeParse(params.input)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
    throw invalid(`Invalid input for "${actionName}": ${detail}`)
  }
  const { path, rest } = fillPath(action.path, parsed.data as Record<string, unknown>)

  // 2. Build the request. Non-body methods send leftovers as the query string.
  const base = new URL(connector.baseUrl)
  const basePath = base.pathname.replace(/\/$/, "")
  const url = new URL(base.origin + basePath + path)
  // Defense in depth: whatever the input was, the request must stay under the connector's base URL.
  if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(basePath + "/"))) {
    throw invalid("The request path resolved outside the connector's base URL.")
  }
  const hasBody = action.method !== "GET" && action.method !== "DELETE"
  if (!hasBody) appendQuery(url, rest)

  const headers = new Headers(connector.defaultHeaders)
  applyAuth(headers, connector.auth, credentials)
  const init: RequestInit = { method: action.method, headers, signal: AbortSignal.timeout(params.timeoutMs) }
  if (hasBody) {
    headers.set("Content-Type", "application/json")
    init.body = JSON.stringify(rest)
  }

  // 3. Call and read, both under the same timeout signal.
  let response: Response
  try {
    response = await params.fetch(url, init)
  } catch (error) {
    throw networkError(error, params.timeoutMs)
  }

  // 4. Normalize errors, keeping what the provider said in `raw` for developers.
  if (!response.ok) {
    let body = ""
    try {
      body = (await readCapped(response, ERROR_BODY_READ_BYTES)).text.slice(0, RAW_BODY_LIMIT_CHARS)
    } catch {
      // The error body is best-effort; the status alone is enough to classify.
    }
    const rateLimitExhausted = response.headers.get("x-ratelimit-remaining") === "0"
    const retryAfter = parseRetryAfter(response.headers, rateLimitExhausted)
    throw errorFromStatus(response.status, {
      raw: { status: response.status, body },
      rateLimitExhausted,
      ...(retryAfter !== undefined && { retryAfter }),
    })
  }

  // 5. Read with a size cap, then validate the shape so callers get typed, trustworthy data.
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > params.maxResponseBytes) {
    await response.body?.cancel()
    throw new ConnectorKitError("upstream_error", `The provider response is too large (limit ${params.maxResponseBytes} bytes).`, { retryable: false, status: response.status })
  }
  let text: string
  try {
    const read = await readCapped(response, params.maxResponseBytes)
    if (read.truncated) {
      throw new ConnectorKitError("upstream_error", `The provider response is too large (limit ${params.maxResponseBytes} bytes).`, { retryable: false, status: response.status })
    }
    text = read.text
  } catch (error) {
    if (error instanceof ConnectorKitError) throw error
    throw networkError(error, params.timeoutMs)
  }

  let body: unknown
  if (response.status !== 204 && text !== "") {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ConnectorKitError("upstream_error", "The provider returned a response that was not valid JSON.", { retryable: false, status: response.status })
    }
  }
  const output = action.output.safeParse(body)
  if (!output.success) {
    throw new ConnectorKitError("upstream_error", `The provider response did not match the expected shape for "${actionName}".`, { retryable: false, status: response.status })
  }
  return output.data
}
