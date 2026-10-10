# ADR-015: What a second connector forced: body-cursor pagination and `detectError`

- Status: accepted
- Date: 2026-10-10

## Problem
GitHub fit the core design neatly, which proved little. A second connector with a different shape would show where the design was GitHub-shaped by accident. Slack differs in two ways that matter:
1. **It answers HTTP 200 even when the call failed:** `{ "ok": false, "error": "channel_not_found" }`. Status-code based error mapping sees success, then the body fails schema validation and surfaces as a useless "unexpected shape" error. Worse, retry and token-refresh logic never fires (`token_expired` arrives as a 200).
2. **Lists live inside the body and so does the cursor** (`channels: [...]`, `response_metadata.next_cursor`), and the cursor goes back as a query parameter. Our pagination strategy assumed the body *is* the list and that a cursor replaces the whole URL.

## Decision
- **`ConnectorDefinition.detectError(body)`**: called with the parsed body of every 2xx response; may return a `ConnectorKitError`. From there the standard machinery applies unchanged: `rate_limited` waits, a retryable read is retried, `auth_expired` triggers one token refresh.
- **`PaginationStrategy` generalized:** `items?(body)` locates the list; `nextCursor({ headers, body })` may read the body; `applyCursor(firstPageUrl, cursor)` replaces the URL (Link header) or adds one parameter (body cursor). The kit always builds the first-page request (path, filters, page size) and then applies the cursor, so filters survive every page. The result must still lie under the connector's base URL.
- **`bodyCursorPagination({ itemsKey, cursorPath })`** ships beside `linkHeaderPagination()`.
- **Slack error text is never echoed into messages** unless it is a short `[a-z0-9_]` token; everything else stays in the non-enumerable `raw`.
- **`chat.postMessage` is `effect: "write"` and NOT `safeToRetry`**: a timeout may mean it was already posted, and retrying would post it twice. It is still retried on a 429, where Slack provably did not process it.
- Slack OAuth: bot scopes, comma-separated, PKCE off (Slack does not document it for the web flow).

## Why
These are not Slack quirks: Stripe-style cursors and "200 with an error" APIs (Slack, many GraphQL and RPC-style APIs) are common. Fixing them in the core, once, keeps connectors short and declarative.

## Trade-offs
`PaginationStrategy` changed shape, which breaks any custom strategy written against ADR-010 (pre-1.0, none known). `detectError` sees only the body, not headers.

## When we may revisit
GraphQL (errors in an `errors` array alongside partial `data`) will probably need a richer hook, and offset pagination needs a strategy.
