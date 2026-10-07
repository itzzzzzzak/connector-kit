import type { ActionDefinition } from "./define.js"
import type { ConnectorKitError } from "./errors.js"

/** ADR-008. All durations in milliseconds. */
export interface RetryOptions {
  /** Retries AFTER the first attempt. 0 disables retrying. */
  maxRetries: number
  /** Total time the kit may spend sleeping across all retries of one call. */
  maxWaitMs: number
  baseDelayMs: number
  maxDelayMs: number
  /** Injectable so tests run instantly. */
  sleep(ms: number): Promise<void>
  /** Injectable so jitter is deterministic in tests. Returns [0, 1). */
  random(): number
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  maxWaitMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
}

/**
 * A request whose outcome we cannot know (timeout, 5xx, dropped connection) may already
 * have taken effect. Re-sending is only safe if repeating it changes nothing. Reads are;
 * writes are only if the connector author says so with `safeToRetry`.
 */
export function isSafeToRetry(action: Pick<ActionDefinition, "effect" | "safeToRetry">): boolean {
  return action.safeToRetry ?? action.effect === "read"
}

/** Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^n)). */
function backoffMs(retriesDone: number, o: RetryOptions): number {
  return Math.floor(o.random() * Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** retriesDone))
}

/** How long to wait before the next attempt, or null to give up and surface the error. */
export function retryDelayMs(
  error: ConnectorKitError,
  action: Pick<ActionDefinition, "effect" | "safeToRetry">,
  retriesDone: number,
  waitedMs: number,
  o: RetryOptions,
): number | null {
  if (retriesDone >= o.maxRetries) return null

  let delay: number
  if (error.code === "rate_limited") {
    // The provider refused the request, so nothing happened: safe to retry for EVERY action.
    delay = error.retryAfter !== undefined ? error.retryAfter * 1000 : backoffMs(retriesDone, o)
  } else if (error.code === "upstream_error" && error.retryable && isSafeToRetry(action)) {
    delay = backoffMs(retriesDone, o)
  } else {
    return null
  }

  // Never sleep past the budget: a serverless function or an agent cannot wait minutes.
  return waitedMs + delay > o.maxWaitMs ? null : delay
}
