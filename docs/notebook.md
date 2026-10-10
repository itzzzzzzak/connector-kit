# ConnectorKit — Engineering Notebook

Living document. Updated as the project teaches us things.

## Problem

Every AI product and SaaS integration re-implements auth, token refresh, pagination, rate limits, retries and error handling. Existing open options are source-available, closed at the runtime layer, or built for batch ETL rather than agent tool calls.

## Users

- **Primary:** developers building AI products and agents that need tools for external SaaS.
- **Secondary:** app developers building SaaS integrations or custom internal integrations.

Both consume a library via `npm install`.

## Requirements (v0.1)

- Declarative connector definitions with handler escape hatches for unusual APIs.
- Multi-tenant: every call is scoped to a `connectionId` (an end user's account).
- Auth: API key / bearer first, then OAuth2 with refresh.
- Pagination, rate limiting, safe retries, normalized errors.
- Output adapters: typed SDK and agent tools (MCP after).
- Permissive license (MIT) covering the runtime.

## Non-goals

Hosted service, UI, sync engine (SyncCore), agent loop, workflow engine (DurableRun), policy engine (MCP Gatekeeper), competing on connector count.

## Architecture

```text
   Agent app / developer app
             |
   ADAPTERS:  toTools()  ·  MCP  ·  typed SDK  ·  handleWebhook (v0.2)
             |
   CORE: execute(action, input, connectionId)
         beforeExecute hook → validate (Zod) → resolve connection/refresh token
         → rate limiter → HTTP client + retry → paginate → normalize result/error
        /                                  \
   CONNECTORS (definitions)            STORES (TokenStore: memory, Postgres)
```

**Invariants**
- The core knows nothing about agents; adapters know nothing about specific providers.
- Every call passes through `execute`.
- Connectors describe *what*; the runtime owns *how*. Even hand-written handlers use the kit's `ctx.http`, so they inherit auth, retries and rate limits.

## Agent-first differences from a developer SDK

| Developer | Agent |
|---|---|
| Reads docs once | Reads the tool description on every call |
| Iterates with `for await` | Gets one bounded response plus a cursor |
| Handles errors in code | Needs errors it can read and act on |
| Trusts its own code | May hallucinate arguments or loop |
| May see the token | Must never see the token |

## Call flow (agent tool call)

1. Model emits an action call.
2. Adapter validates input; invalid input returns a model-readable error.
3. Host `beforeExecute` hook may deny or require approval, based on `effect` (`read` / `write` / `destructive`).
4. Core resolves the connection, refreshing the token if expired.
5. Rate limiter, then HTTP. On 429, wait up to a bounded budget; otherwise return `rate_limited` with `retryAfter`. Retry only when the request was not processed or the action is `safeToRetry`.
6. Result is trimmed and normalized, or a normalized error is returned.
7. Result returns to the model. The token never enters model context.

## Concepts to learn

OAuth2, PKCE, `state` (CSRF), token-refresh races and locking, exponential backoff with jitter, `Retry-After`, idempotency keys, cursor pagination, JSON Schema, MCP / JSON-RPC, envelope encryption for stored tokens.

## Security boundaries

- Tokens never enter model context or logs.
- Tokens encrypted at rest; the key is supplied by the host.
- OAuth `state` verified on callback.
- Input validated before any outbound call.
- API responses are untrusted data (possible prompt injection); the kit returns data, never instructions.

## Failure scenarios to test deliberately

Token expires mid-call; two concurrent calls both refresh; 429 with long `Retry-After`; 5xx on a non-idempotent write; malformed JSON upstream; stale pagination cursor; provider revokes the token.

## Performance

Overhead is validation plus a store lookup. Cache the token lookup briefly in memory. The real limits are provider rate limits and the database.

## Cost

Operating cost is essentially one Postgres table.

## Future scale

| Users | What changes |
|---|---|
| 10 | Nothing; in-memory store works |
| 100 | Postgres store; token-refresh lock matters |
| 1,000 | Rate-limit state shared across servers; connection-pool tuning |
| 10,000 | Per-provider fairness across tenants; queueing (DurableRun territory); token store partitioning |

## Decisions

See [docs/adr](adr). Index: 001 TypeScript + Zod · 002 library not server · 003 TokenStore interface · 004 declarative connectors + escape hatches · 005 actions before sync · 006 app hosts OAuth callback · 007 effect labels + optional hook · 008 bounded wait, safe retries · 009 error taxonomy · 010 pagination · 011 agent tools + policy hook · 012 GitHub distribution, single package · 013 MCP server · 014 OAuth + token store.

## Failures

- **Path traversal via path parameters (found in PR #1 review, reproduced).** `owner: ".."` turned `/repos/{owner}/{name}` into a request to `/user`: `encodeURIComponent` leaves dots alone and `new URL()` collapses `..`. Impact: an untrusted caller (an LLM) could steer a call, carrying the user's token, to another endpoint on the same host. Fix: reject `.`, `..` and empty values, plus a post-build check that the URL stays under the connector's base URL. Regression test verified to fail without the guard.
- **No timeout / no response cap.** A silent provider could hang `execute` forever, and a huge response could exhaust memory. Fix: `AbortSignal.timeout` (default 30 s) and a streamed size cap (default 1 MB).
- **GitHub signals rate limits with 403.** Treating every 403 as "permission denied" would tell an agent not to retry. Fix: 403 with `x-ratelimit-remaining: 0` maps to `rate_limited`; other 403s map to the new `forbidden` code.

## Mistakes / misunderstandings

- **A sync throw inside a function meant to be awaited.** `kit.startAuth` threw configuration errors synchronously, so `kit.startAuth(...).catch(...)` would never see them. My own test caught it. Any function that returns a Promise should be `async` so every failure is a rejection.
- **A test fake that silently parsed nothing.** My fake token endpoint read `init.body` as a string, but `fetch` was given a `URLSearchParams`; the fake saw an empty form and ten tests failed in confusing ways. Debug the fake before the code under test.
- **Mutation checks should assert their own pattern exists.** After two invalid mutations I made the script fail loudly when the text to change is not found. It then caught a third bad guess immediately.

- **Two invalid mutation checks in a row.** One `sed` pattern (`cipher.setAAD`) also matched inside `decipher.setAAD`, leaving a dangling `de` that broke decryption entirely, so the 'moved record' test was never the one failing. A valid mutation changes exactly one behavior and fails exactly the tests meant to catch it; check which tests failed, not just that something did.
- **Polling CI with a loop that exited immediately.** `gh pr checks` prints 'no checks reported' before CI registers, and my 'until no pending' loop treated that as done. Wait for the expected number of checks to exist first.

- **A smoke test that did not test what it claimed.** The first version launched the MCP CLI by file path, so breaking the package's `bin` field did not fail it; the mutation check exposed this. It also embedded code in a template string, where a backslash-n became a real newline and broke the script. Lessons: exercise the *interface users use* (the installed `bin` command), keep scripts in real files, and always check a test can fail.
- **Re-exported a Node-only module from the package root.** Caught in review of my own diff: the MCP server imports `node:readline`, which would have broken edge-runtime users of the core. Node-only code lives behind its own subpath.

- **Verified on a dirty checkout.** `pnpm typecheck` passed locally but failed on CI: the examples import `connector-kit` by name, which resolves to `dist/*.d.ts`, and my machine had a stale `dist/` from earlier builds. Lesson: verify from a clean state (`git clean -fdx -e node_modules`, or a fresh clone) before pushing, and make scripts build what they depend on.

- **Assumed a `prepare` build hook would make `github:` installs work.** Testing a real install showed current npm blocks dependency install scripts until approved, so the package would have arrived unbuilt. Lesson: simulate the user's install (`pnpm smoke`) before documenting it. Also: the first layout (two packages + peer dependency + registry release tooling) was designed before deciding where the code would be distributed; decide the distribution channel first.

- **Test-fixture off-by-one.** My fake fetch pushed to `calls` before invoking the handler, so `calls.length === 0` was never true inside it; and I forgot the default `per_page` made `url.search` non-empty. Both made the pagination iterator test fail while the code was correct. Lesson: when a test fails, read the actual output before changing product code.

- **A green run that ran the wrong thing.** `node --test dist/` reported "1 test, 1 pass" while our 7 real tests never executed. Lesson: check that the *number* of tests run matches what you expect, and use an explicit glob (`dist/**/*.test.js`).
- **`declared engines: node >=20`** while the test glob needed Node 21+. Declared support must match what is actually exercised in CI (now `>=22`).
- **Passed locally (Node 26), failed on CI (Node 22).** The timeout test used a fake provider that never settles; `AbortSignal.timeout()` uses an unref'd timer, so on CI Node saw an empty event loop and cancelled the test. Lesson: CI is the second opinion; keep a ref'd handle in tests that wait on timers, and always check the exact failing log before guessing.
- **Assuming validation covers everything.** Zod proves a value is a string, not that it is a *safe path segment*. Type validation and security validation are different jobs.

## Concepts encountered

- AEAD (AES-GCM): nonce must never repeat per key; associated data binds ciphertext to its context; envelope versioning and key ids for rotation.
- OAuth 2.0 authorization-code flow, `state` (CSRF), PKCE S256, refresh-token rotation, the refresh race and why a lock plus re-read-inside-the-lock fixes it.

- MCP over stdio: JSON-RPC 2.0, newline-delimited framing, protocol-version negotiation, notifications vs requests, tool annotations, `isError` vs JSON-RPC errors; stdout must carry only protocol messages.

- Package `exports` subpaths, self-referencing a package by its own name, `files`/`prepack` vs `prepare`, npm script gating for dependencies, conventional commits + release-please for automated versioning without a registry.

- Fail-closed vs fail-open policy hooks; why a denial must not depend on the hook behaving.
- JSON Schema for LLM tool calling (generated from Zod); tool-name character limits.
- Mutation checks can themselves be wrong: my first fail-open mutation broke the file's syntax and 'failed' whole test files for the wrong reason. A valid mutation changes one behavior and fails one targeted test.

- Retry safety: 'not processed' (429) vs 'outcome unknown' (timeout/5xx); idempotency decides whether re-sending is safe.
- Exponential backoff with full jitter (avoids synchronized retry storms); a shared wait budget; injecting `sleep`/`random` for deterministic tests.

- Pagination styles (Link header, body cursor, offset); opaque cursors; why agents get one bounded page while developers get an async iterator.

- Path traversal / dot-segment normalization in URLs; percent-encoding vs. URL parsing.
- `AbortSignal.timeout` and why every outbound call needs a deadline.
- Streaming reads with a byte cap (never buffer an unbounded body).
- `Retry-After` may be seconds or an HTTP date; some providers signal limits via `x-ratelimit-*` headers and 403.
- Non-enumerable properties to keep sensitive detail out of `JSON.stringify` and naive logging.
- Mutation-checking a test: remove the fix, confirm the test goes red.
