import { ConnectorKitError, errorFromStatus } from "./errors.js"
import type { ActionDefinition, AuthConfig, ConnectorDefinition } from "./define.js"

export interface Credentials {
  token: string
}

export interface ExecuteParams {
  connector: ConnectorDefinition<Record<string, ActionDefinition>>
  actionName: string
  input: unknown
  credentials: Credentials
  fetch: typeof fetch
}

function applyAuth(headers: Headers, auth: AuthConfig, credentials: Credentials): void {
  if (auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${credentials.token}`)
  } else {
    headers.set(auth.header, `${auth.prefix ?? ""}${credentials.token}`)
  }
}

/** Fill {params} in the path from the input; return the path and the leftover fields. */
function fillPath(template: string, input: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
  const rest = { ...input }
  const path = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = rest[key]
    if (value === undefined || value === null) {
      throw new ConnectorKitError("invalid_input", `Missing required path parameter "${key}".`, { retryable: false })
    }
    delete rest[key]
    return encodeURIComponent(String(value))
  })
  return { path, rest }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/**
 * The single choke point (see docs/notebook.md): validate → auth → HTTP → normalize.
 * Retries, rate limiting and the beforeExecute hook will be added here, not around it.
 */
export async function execute(params: ExecuteParams): Promise<unknown> {
  const { connector, actionName, credentials } = params
  const action = connector.actions[actionName]
  if (!action) {
    throw new ConnectorKitError("invalid_input", `Unknown action "${actionName}" on connector "${connector.name}".`, { retryable: false })
  }

  // 1. Validate BEFORE any network call. Agents hallucinate arguments.
  const parsed = action.input.safeParse(params.input)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
    throw new ConnectorKitError("invalid_input", `Invalid input for "${actionName}": ${detail}`, { retryable: false })
  }
  const { path, rest } = fillPath(action.path, parsed.data as Record<string, unknown>)

  // 2. Build the request. Non-body methods send leftovers as the query string.
  const url = new URL(connector.baseUrl.replace(/\/$/, "") + path)
  const hasBody = action.method !== "GET" && action.method !== "DELETE"
  if (!hasBody) {
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  const headers = new Headers(connector.defaultHeaders)
  applyAuth(headers, connector.auth, credentials)
  const init: RequestInit = { method: action.method, headers }
  if (hasBody) {
    headers.set("Content-Type", "application/json")
    init.body = JSON.stringify(rest)
  }

  // 3. Call. A thrown fetch is a network failure, not a provider answer.
  let response: Response
  try {
    response = await params.fetch(url, init)
  } catch {
    // Deliberately no cause/URL details: keep secrets and internals out of errors.
    throw new ConnectorKitError("upstream_error", "Could not reach the provider (network error).", { retryable: true })
  }

  // 4. Normalize errors.
  if (!response.ok) {
    throw errorFromStatus(response.status, parseRetryAfter(response.headers.get("retry-after")))
  }

  // 5. Validate the response shape so callers get typed, trustworthy data.
  let body: unknown
  try {
    body = response.status === 204 ? undefined : await response.json()
  } catch {
    throw new ConnectorKitError("upstream_error", "The provider returned a response that was not valid JSON.", { retryable: false, status: response.status })
  }
  const output = action.output.safeParse(body)
  if (!output.success) {
    throw new ConnectorKitError("upstream_error", `The provider response did not match the expected shape for "${actionName}".`, { retryable: false, status: response.status })
  }
  return output.data
}
