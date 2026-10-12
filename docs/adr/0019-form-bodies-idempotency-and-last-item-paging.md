# ADR-019: Form bodies, idempotency keys and last-item paging

- Status: accepted
- Date: 2026-10-12

## Problem
Stripe is the connector people ask for first, and it is unlike everything in the catalog so far. Its requests are not JSON: they are `application/x-www-form-urlencoded`, with nested data written as `metadata[order]=1` and lists as `items[0][price]=p`. A list response carries no cursor: the next page begins after the id of the last item. And a payment is the one place where "retry after a timeout" is dangerous: a second POST can charge twice, which is why ADR-008 never retries a write. Twilio shares the first of these (with repeated keys instead of indices); Square and Resend share the third.

## Alternatives considered
- Send JSON and hope. Rejected: Stripe does not accept it.
- Let each connector build its own body string with `buildBody`. Rejected: it would be written wrong several times (escaping, nesting), and the encoder is security relevant (an `&` in a customer name must not start a new field).
- A per-action `idempotencyKey` input. Rejected for now: a model has to invent and remember a key, which is the kind of thing models get wrong. It can be added later for callers who want a key that survives across separate calls.

## Decision
- **`bodyFormat`** on a connector: `"json"` (default), `"form"` (arrays are indexed, Stripe) or `"form-repeat"` (arrays repeat the key, Twilio). `src/form.ts` flattens objects and arrays to bracket notation and percent-encodes names and values. `null` becomes an empty value (how these APIs clear a field), `undefined` and empty lists are left out, and a function or symbol is an error instead of the word "undefined" on the wire. Object and array **query** values of a form connector use the same notation (`created[gte]=5`).
- **`idempotencyKeyHeader`** on a connector (Stripe: `Idempotency-Key`). Every POST then carries one random key per call, the same key on each retry of that call, and the kit treats such a POST as safe to retry: the provider drops the duplicate. GET and DELETE carry no key. The conformance rule that forbids `safeToRetry` on a POST stays; the connector opts in once, not per action.
- **`lastItemPagination`**: a list is a field of the body, `has_more` says whether another page exists, and the cursor handed to callers is the last item's id, sent back as `starting_after`. A page that claims `has_more` but has no usable last id ends paging rather than looping.
- **The generator** reads form-encoded request bodies (`formEncoded`), names operations from the path when the provider's operation ids are no help (`naming: "rest"`: `customers.list`, `customers.listBankAccounts`, `paymentIntents.confirm`), marks verbs such as cancel, void, close and refund as destructive, and turns enums longer than 30 values into plain strings (a model does not need the list of every bank in Austria).

## Why
The encoder is one small, tested file; every form provider reuses it. Making the retry decision at the connector level (does the provider document an idempotency header?) keeps the rule honest: the kit only retries a POST when the provider has promised to deduplicate it.

## Trade-offs
- An empty list cannot be sent. Stripe has no way to say "empty list" in a form either; the field is simply omitted.
- A retried POST after a timeout can return the first request's result, including its error, because Stripe replays the stored response for a key. That is the point, but a caller should know it.
- A failed card is HTTP 402; it is surfaced as `upstream_error` with the provider detail in `raw`, as for any other unexpected status.

## When we may revisit
When a provider needs multipart uploads (Stripe `files.create`, skipped here), or when callers need a key that spans several calls.
