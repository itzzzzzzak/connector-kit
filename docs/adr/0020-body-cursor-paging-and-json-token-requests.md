# ADR-020: Cursor paging in a POST body, and JSON OAuth token requests

- Status: accepted
- Date: 2026-10-12

## Problem
Notion needs two things the kit could not express. Its search and "query a data source" calls are POSTs whose page size and cursor are fields of the JSON body (`page_size`, `start_cursor`), while every strategy so far puts them in the URL. And its OAuth token endpoint expects a JSON request, where the kit sent the standard form encoding.

## Alternatives considered
- Treat a Notion search as an unpaged call and let the caller loop by hand. Rejected: search and queries are how every Notion workflow starts, and they return 25 to 100 rows at a time.
- A new strategy per provider. Rejected: only the place the cursor travels differs, so one option on the existing body-cursor strategy is enough.
- Sniff the token endpoint and try both encodings. Rejected: guessing sends the client secret twice.

## Decision
- `bodyCursorPagination({ cursorIn: "body" })`. The kit puts the page size and cursor into the JSON body (after `buildBody`, which never sees them), leaves the URL alone, and reads the next cursor from the response as before. Such an action may be a POST. It stays a `read` when it only reads, so it is retried after a 5xx like any read. The cursor is still checked on the way out (a next-page cursor must not lead outside the base URL).
- `auth.tokenRequestFormat: "json"` on an `oauth2` connector sends the code exchange and refresh as JSON. Client authentication (`body` or `basic`) is unchanged; Notion uses `basic`.

## Why
Both are one small, tested option each, off by default, so no existing connector changes behavior.

## Trade-offs
A body-paged action must declare `buildBody` if it also uses `buildQuery`, as for other POSTs. Notion also sends no scopes and no PKCE, which an existing connector setting (`pkce: false`, no `scopes`) already expresses.

## When we may revisit
For GraphQL (Linear), where the cursor is a variable inside the body (ADR-021).
