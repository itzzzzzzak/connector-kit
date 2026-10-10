# ADR-014: OAuth 2.0, the TokenStore, encryption at rest, and refresh

- Status: accepted and implemented (in-memory and Postgres stores)
- Date: 2026-10-10
- Supersedes the open questions in ADR-003 and ADR-006

## Problem
A product with many users needs each user to connect their own account, and the kit must remember, protect and renew each user's tokens. Four things are easy to get wrong: forged logins (CSRF), plaintext secrets at rest, expired tokens, and two requests refreshing the same token at once.

## Decision

**Storage is a dumb string key-value interface (`TokenStore`).** `get/set/delete`, `putTemp/takeTemp` (expiring, atomic read-and-delete, used for OAuth `state`), and `withLock` (mutual exclusion per key, used for refresh). The kit serializes values itself. Implementations: `memoryTokenStore()` (try-out and tests; the lock only works within one process) and a Postgres store (next PRs; its lock must work across processes).

**Encryption is a wrapper, not a feature of each store** (`encryptedStore(store, encryption)`). AES-256-GCM, a fresh random 96-bit nonce per value, versioned envelope `ck1.<keyId>.<iv>.<tag>.<ciphertext>`. **The store key is bound in as additional authenticated data**, so a record copied onto another connection's key fails to decrypt (someone with database write access cannot swap one user's tokens for another's). Keys are identified by id: new values use `current`, old values still decrypt, so keys can rotate. **The host supplies the key; it must not live in the same database as the data.** Decryption failure reveals nothing about why (wrong key, wrong AAD and tampering are indistinguishable) and is a `storage_error`.

**Where tokens live:** in the host's store, owned by the host, scoped by `connectorName/connectionId` (URL-encoded segments, so a `connectionId` cannot forge another's key).

**OAuth flow:** `kit.startAuth(connector, { connectionId })` returns the provider URL; the host redirects the user. `kit.finishAuth(connector, { code, state })` runs in the host's callback route. The kit runs no server (ADR-006).
- `state`: 32 random bytes, stored server-side with a 10 minute ttl, **single use**, and it carries the `connectionId`, so the callback cannot name a different connection. The host may also pass `expectedConnectionId` (the logged-in user) and a mismatch is rejected.
- **PKCE (S256)** by default; the verifier is stored with the state and never leaves the server.
- Token and authorize endpoints must be `https` (loopback allowed for tests); provider error text goes only to the non-enumerable `raw`, never into messages.

**Refresh:** refresh when the token is within 60 s of expiry, under `withLock`, **re-reading the record inside the lock** so callers that waited reuse the winner's result instead of refreshing again. A refresh token that rotates is saved; one that does not is kept. `invalid_grant` means the user must reconnect: the record is deleted (`not_connected` afterwards). A transient failure (network, 5xx) keeps the record. A `401` mid-call triggers **one** forced refresh and one retry (a 401 means the request was rejected, so replaying is safe for any action); if the token another caller already refreshed differs from the one that failed, it is used without refreshing again.

**New error codes:** `not_connected` (no stored credentials; the user must connect) and `storage_error` (stored data could not be read or decrypted).

## Found while building
- `startAuth`/`finishAuth` must always return a promise: a missing-configuration error thrown synchronously would slip past `.catch()`. They are `async`; configuration problems reject.
- GitHub reports OAuth errors with HTTP 200 and an `error` field, so the error check must not depend on the status code.
- Verified against a local HTTP server that invalidates each refresh token on first use, with 8 concurrent callers: exactly one refresh per expiry.

## The Postgres store's lock (and why it is not an advisory lock)
The textbook cross-process lock is `pg_advisory_lock` on a dedicated connection. We do not use it: every *waiter* would hold a pool connection while it waits, so the lock *holder* can be starved of the connection it needs to do its own reads and writes (a pool deadlock), and session or transaction advisory locks do not survive transaction-mode poolers such as pgbouncer. Instead the lock is a **lease row**: one atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()` claims it or takes it over from an expired holder, waiters poll with jittered backoff and hold no connection, and the holder releases with `DELETE ... WHERE value = <owner>` so a holder whose lease expired cannot remove its successor's lock. Cost: a lock is only as exclusive as its lease (`leaseMs`, default 120 s, must exceed the longest refresh), and waiting polls the database. The same shared contract test suite runs against the memory and Postgres stores.

## Alternatives considered
- A store that returns typed credential objects (simpler, but encryption would have to be re-implemented in every store).
- Encrypting only the refresh token (the access token is just as usable for its lifetime).
- Optimistic concurrency instead of a lock for refresh (cannot prevent two refresh requests from reaching the provider, which is exactly the harm).
- Running a callback server inside the kit (conflicts with ADR-002/006).

## Trade-offs
Every store implementer must get `takeTemp` atomicity and `withLock` right; the interface documents this and the in-memory store is the reference. A store shared across processes without a cross-process lock reintroduces the refresh race. Encryption at rest protects against database leaks, not against a compromised application process, which holds the key.

## When we may revisit
Token revocation on disconnect, refresh-token reuse detection, per-tenant keys, or a hosted KMS adapter.
