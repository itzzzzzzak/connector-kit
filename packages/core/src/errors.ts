// ADR-009: a small, normalized error set that callers (and agents) can branch on.
export type ErrorCode =
  | "auth_expired"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "invalid_input"
  | "upstream_error"

/** What the provider actually said. For developers debugging; never forwarded to models by default. */
export interface RawDetails {
  status: number
  /** Response body, truncated. */
  body: string
}

export interface ConnectorKitErrorInit {
  retryable: boolean
  status?: number
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfter?: number
  raw?: RawDetails
}

export class ConnectorKitError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status: number | undefined
  readonly retryAfter: number | undefined
  /** Non-enumerable on purpose: keeps provider bodies out of JSON.stringify(error) and naive logging. */
  declare readonly raw: RawDetails | undefined

  constructor(code: ErrorCode, message: string, init: ConnectorKitErrorInit) {
    super(message)
    this.name = "ConnectorKitError"
    this.code = code
    this.retryable = init.retryable
    this.status = init.status
    this.retryAfter = init.retryAfter
    Object.defineProperty(this, "raw", { value: init.raw, enumerable: false, writable: false, configurable: true })
  }
}

export interface StatusDetails {
  retryAfter?: number
  raw?: RawDetails
  /** True when the provider says the rate limit budget is used up (e.g. x-ratelimit-remaining: 0). */
  rateLimitExhausted?: boolean
}

/** Map an HTTP status to our taxonomy. Messages are written to be read by a model. */
export function errorFromStatus(status: number, details: StatusDetails = {}): ConnectorKitError {
  const { retryAfter, raw, rateLimitExhausted } = details
  const init = (retryable: boolean): ConnectorKitErrorInit => ({
    retryable,
    status,
    ...(retryAfter !== undefined && { retryAfter }),
    ...(raw !== undefined && { raw }),
  })

  if (status === 401) {
    return new ConnectorKitError("auth_expired", "The credentials were rejected. They may be expired or revoked.", init(false))
  }
  if (status === 403) {
    // Some providers (e.g. GitHub) signal rate limiting with 403 instead of 429.
    if (rateLimitExhausted) {
      return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", init(true))
    }
    return new ConnectorKitError("forbidden", "The credentials are valid but not allowed to do this. Check scopes or permissions.", init(false))
  }
  if (status === 404) {
    return new ConnectorKitError("not_found", "The requested resource was not found, or the credentials cannot see it.", init(false))
  }
  if (status === 429) {
    return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", init(true))
  }
  if (status === 400 || status === 422) {
    return new ConnectorKitError("invalid_input", "The provider rejected the request as invalid.", init(false))
  }
  return new ConnectorKitError("upstream_error", `The provider returned an unexpected error (HTTP ${status}).`, init(status >= 500))
}
