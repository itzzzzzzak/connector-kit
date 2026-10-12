# ADR-021: GraphQL actions

- Status: accepted
- Date: 2026-10-12

## Problem
Linear has one endpoint, `POST /graphql`, where every call is a document plus variables. The kit's actions are one HTTP request each, with a path, a method and an input. Three things did not fit: the request body is `{ query, variables }` and not the input itself; the cursor and page size are variables inside it (`variables.after`, `variables.first`); and failures come back as HTTP 200 with an `errors` array, while rate limiting is HTTP 400. Linear also takes a personal API key without `Bearer` and an OAuth token with it.

## Alternatives considered
- Let a caller pass any GraphQL document through one `query` action. Rejected: an agent would write schema-guessing queries and the kit could not tell a read from a write, so it could not retry safely or ask for confirmation.
- A GraphQL client library at run time. Rejected: a second dependency and a second transport for what is one POST.
- Generate hundreds of actions from the schema, as for OpenAPI. Deferred: the curated set covers what people do; more can be added with the same helper.

## Decision
- `graphqlAction({ description, query, field, input, output, effect, connection? })` returns an ordinary action: a POST to `/graphql` whose body is `{ query, variables }`, where the variables are the validated input (shaped by `buildBody` when given). The result is `data.<field>`. The author states `effect`, so a query is a retried read and a mutation is not.
- `relayPagination` is a body-cursor strategy with dotted fields: the kit sets `variables.first` and `variables.after`, and reads `nodes` and `pageInfo` from the connection. The kit builds the body immutably, so one call never changes another's variables.
- `detectGraphqlError` (for `detectError`) maps `errors[0].extensions` to the kit's codes. Partial data next to errors counts as a failure. The provider's text stays in `raw`, never in the message.
- `connector.detectHttpError` lets a connector classify a failed response from its body and headers before the status mapping (Linear: 400 with `RATELIMITED` is a retryable `rate_limited`, `retryAfter` from `X-RateLimit-Requests-Reset`).
- `auth.rawTokenPattern` (a regular expression, checked by the conformance test): a token that matches is sent as the whole `Authorization` value.

## Why
Each piece is small and optional, and an existing connector behaves exactly as before. The model still sees typed inputs and outputs, not GraphQL.

## Trade-offs
Each action carries a fixed selection set, so a caller cannot ask for a field that action does not return. That keeps results small and typed. Linear's connector is therefore curated (23 actions), not the whole schema.

## When we may revisit
If other GraphQL providers (Shopify's Admin API) need the whole schema, add a generator that writes `graphqlAction` calls from introspection.
