// ADR-009: a small, normalized error set that callers (and agents) can branch on.
export type ErrorCode =
  | "auth_expired"
  | "rate_limited"
  | "not_found"
  | "invalid_input"
  | "upstream_error"

export interface ConnectorKitErrorInit {
  retryable: boolean
  status?: number
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfter?: number
}

export class ConnectorKitError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status: number | undefined
  readonly retryAfter: number | undefined

  constructor(code: ErrorCode, message: string, init: ConnectorKitErrorInit) {
    super(message)
    this.name = "ConnectorKitError"
    this.code = code
    this.retryable = init.retryable
    this.status = init.status
    this.retryAfter = init.retryAfter
  }
}

/** Map an HTTP status to our taxonomy. Messages are written to be read by a model. */
export function errorFromStatus(status: number, retryAfter?: number): ConnectorKitError {
  const init = (retryable: boolean): ConnectorKitErrorInit =>
    retryAfter === undefined ? { retryable, status } : { retryable, status, retryAfter }

  if (status === 401) {
    return new ConnectorKitError("auth_expired", "The credentials were rejected. They may be expired or revoked.", init(false))
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
