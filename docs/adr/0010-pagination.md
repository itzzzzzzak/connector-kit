# ADR-010: One-page-per-call pagination with provider strategies

- Status: accepted
- Date: 2026-10-02

## Problem
Providers paginate differently (GitHub: `Link` header; Stripe: `starting_after` in the body; Slack: `next_cursor` in the body). Agents cannot loop and have limited context; developers often want everything.

## Alternatives considered
- `execute` returns every page (unbounded memory and context; bad for agents).
- Separate code paths for agents and developers (breaks the single-`execute` invariant).
- Kit hardcodes each provider's style (core would know providers).

## Decision
- A paginated action declares `paginate: <strategy>`. `execute` returns ONE bounded page: `{ items, nextCursor }`, `nextCursor: null` when done.
- `nextCursor` is opaque to callers. For Link-header APIs the cursor is the full next-page URL.
- Default page size 30, hard max 100 (strategy-configurable); the caller's `pageSize` is clamped.
- The kit ships strategies (`linkHeaderPagination` now; body-cursor and offset later). A connector picks one.
- Developers get `kit.paginate(connection, action, input)`, an async iterator built only on top of `execute`. Agents never use it.
- A connector's `input` schema must declare optional `cursor` and `pageSize`; the kit reads and removes them (the provider never sees `pageSize`).
- Security: any cursor URL, supplied by a caller or read from a provider response, must stay under the connector's base URL, or the call is rejected.

## Why
Same primitive for agents and developers; bounded responses protect model context; provider differences stay inside strategies.

## Trade-offs
Connector authors must remember the `cursor`/`pageSize` input fields (could be auto-injected later). A cursor that is a URL can go stale or expire; callers must treat it as short-lived.

## When we may revisit
When adding Stripe/Slack-style connectors (body-cursor strategy), or if auto-injecting the pagination inputs proves worthwhile.
