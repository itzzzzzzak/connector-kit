# ADR-003: Pluggable TokenStore; in-memory and Postgres implementations

- Status: accepted
- Date: 2026-09-21

## Problem
The kit must persist tokens, expiry, OAuth `state` and later rate-limit state across requests and restarts.

## Alternatives considered
In-memory only; SQLite; Postgres only; Redis; a pluggable interface.

## Decision
A small `TokenStore` interface (`get`, `set`, `delete`). Ship in-memory (try-it-out, tests) and Postgres (production). Tokens are encrypted at rest with a host-supplied key.

## Why
Zero-setup trial via in-memory; Postgres is what most production teams already run and will later serve SyncCore and DurableRun. The interface keeps the kit storage-agnostic.

## Trade-offs
Two implementations to maintain. Concurrent token refresh needs a lock that the interface must support.

## When we may revisit
If users ask for SQLite/Redis (community implementations are welcome).
