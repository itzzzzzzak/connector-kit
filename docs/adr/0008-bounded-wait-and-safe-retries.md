# ADR-008: Bounded silent wait on rate limits; retry only when safe

- Status: accepted
- Date: 2026-09-21

## Problem
Provider rate limits (429) and transient failures need handling without duplicating dangerous operations or hanging callers.

## Decision
- On 429, the kit waits (honoring `Retry-After`) up to a configurable wait budget, then returns a `rate_limited` error with `retryAfter`.
- A 429 means the request was not processed, so retrying is safe.
- On timeouts or 5xx, retry only if the action is `safeToRetry` or an idempotency key is used; otherwise return the error.
- Backoff is exponential with jitter. The kit runs no agent loop.

## Implementation notes (added when built)
- Defaults: `maxRetries: 2`, `maxWaitMs: 30 000` (shared across all retries of one call), backoff base 500 ms, cap 8 000 ms, **full jitter**. All overridable via `createConnectorKit({ retry })`; `{ maxRetries: 0 }` disables.
- "Safe to retry" defaults to `effect === "read"`; a write must opt in with `safeToRetry: true`.
- Each attempt gets a fresh timeout signal.
- A `Retry-After` larger than the remaining budget is not slept on: the `rate_limited` error is returned with `retryAfter` so the caller decides.
- `sleep` and `random` are injectable, so tests run instantly and deterministically.

## Why
Unbounded waits break serverless timeouts and stall agents. Blind retries on writes can create duplicates.

## Trade-offs
Callers may still see `rate_limited` errors and must handle them.

## When we may revisit
When shared rate-limit state across servers is introduced (scale ~1,000 users).
