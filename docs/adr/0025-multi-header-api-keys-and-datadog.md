# ADR-025: Several keys in several headers, and the Datadog connector

- Status: accepted
- Date: 2026-10-12

## Problem
Datadog needs two secrets on every call, `DD-API-KEY` and `DD-APPLICATION-KEY`, each in its own header. The kit's `apiKey` auth sends one value in one header, and a connection holds one credential string. Datadog also differs in three smaller ways: the host depends on the account's site (`datadoghq.com`, `datadoghq.eu`, ...), a bad key answers 403 instead of 401, and its specs hold two API versions with several page styles.

## Alternatives considered
- Put the second key in a connector variable. Rejected: variables go in the URL host and are not secrets, so the application key would be logged and shown like a hostname.
- Add a second credential field to every connection. Rejected for now: it widens `connect()`, the MCP command and every host integration for one provider.

## Decision
- New auth type `{ type: "apiKeys", headers: [...] }`. The credential is the values joined by ":" (`api:app`), in the order of `headers`. `applyAuth` splits it and sets each header; a wrong count is an `invalid` error, and `connect()` reports it up front. Conformance requires at least two distinct, valid header names.
- The Datadog site is a base-URL variable with a closed list of nine sites, so it cannot name another server (ADR-017). The environment variable is `DATADOG_KEYS`.
- A 403 is mapped to `auth_expired`, since Datadog uses it for an invalid key and does not say which key; a 429 is `rate_limited` with `retryAfter` from `X-RateLimit-Reset` (seconds), falling back to `Retry-After`.
- The v2 and v1 specs are generated together (about 1,770 actions in 161 groups, named by tag); deprecated and `/api/unstable/` calls are skipped. Three pagination rules cover the page styles. Eleven hand-written actions cover the common reads; `monitors.list` always sends page 0 because Datadog returns every monitor otherwise.
- Conformance now accepts "disable", "mute", "suspend", "clear", "block", "stop", "empty" and "trash" as words for something destroyed.

## Why
It keeps a secret a secret, needs no change to the connection model, and is a small extension of an existing auth switch.

## Trade-offs
Keys that contain ":" cannot be used (Datadog keys are hex). The 403 mapping hides a genuine "key lacks permission" case behind an auth message that names both possibilities.

## When we may revisit
Named credential fields on a connection, if a second provider needs three or more secrets.
