import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectorKitError } from "./errors.js"
import { createEncryption, encryptedStore, generateEncryptionKey } from "./crypto.js"
import { memoryTokenStore } from "./store.js"

const tick = () => new Promise((resolve) => setImmediate(resolve))

// ------------------------------------------------------------------ memory store

test("get / set / delete", async () => {
  const store = memoryTokenStore()
  assert.equal(await store.get("a"), undefined)
  await store.set("a", "1")
  assert.equal(await store.get("a"), "1")
  await store.delete("a")
  assert.equal(await store.get("a"), undefined)
})

test("a temp value can be taken exactly once", async () => {
  const store = memoryTokenStore()
  await store.putTemp("state", "payload", 1000)
  assert.equal(await store.takeTemp("state"), "payload")
  assert.equal(await store.takeTemp("state"), undefined)
})

test("two concurrent takes: only one wins", async () => {
  const store = memoryTokenStore()
  await store.putTemp("state", "payload", 1000)
  const results = await Promise.all([store.takeTemp("state"), store.takeTemp("state")])
  assert.deepEqual(results.filter((r) => r !== undefined), ["payload"])
})

test("a temp value is gone after its ttl, and an expired take still consumes it", async () => {
  let clock = 1_000
  const store = memoryTokenStore({ now: () => clock })
  await store.putTemp("state", "payload", 500)
  clock = 1_501
  assert.equal(await store.takeTemp("state"), undefined)
  clock = 1_100
  assert.equal(await store.takeTemp("state"), undefined)
})

test("withLock runs callers one at a time, in order", async () => {
  const store = memoryTokenStore()
  const log: string[] = []
  const job = (name: string) =>
    store.withLock("k", async () => {
      log.push(`${name}:start`)
      await tick()
      await tick()
      log.push(`${name}:end`)
    })
  await Promise.all([job("a"), job("b"), job("c")])
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"])
})

test("withLock releases when the function throws, and returns its value", async () => {
  const store = memoryTokenStore()
  await assert.rejects(() => store.withLock("k", async () => { throw new Error("boom") }), /boom/)
  assert.equal(await store.withLock("k", async () => 42), 42)
})

test("locks on different keys do not block each other", async () => {
  const store = memoryTokenStore()
  let releaseA!: () => void
  const aHeld = new Promise<void>((r) => (releaseA = r))
  const a = store.withLock("a", () => aHeld)
  assert.equal(await store.withLock("b", async () => "b-done"), "b-done")
  releaseA()
  await a
})

// ------------------------------------------------------------------ encryption

const keyA = generateEncryptionKey()
const keyB = generateEncryptionKey()

test("generateEncryptionKey returns 32 random bytes (base64) and is unique", () => {
  assert.equal(Buffer.from(keyA, "base64").length, 32)
  assert.notEqual(keyA, keyB)
})

test("encrypt then decrypt round-trips, and two encryptions of the same text differ (fresh nonce)", () => {
  const enc = createEncryption({ current: "k1", keys: { k1: keyA } })
  const one = enc.encrypt("secret-token", "cred/github/u1")
  const two = enc.encrypt("secret-token", "cred/github/u1")
  assert.notEqual(one, two)
  assert.equal(enc.decrypt(one, "cred/github/u1"), "secret-token")
  assert.ok(!one.includes("secret-token"))
})

const storageError = (e: unknown) => e instanceof ConnectorKitError && e.code === "storage_error" && !e.retryable

test("a tampered ciphertext does not decrypt", () => {
  const enc = createEncryption({ current: "k1", keys: { k1: keyA } })
  const envelope = enc.encrypt("secret-token", "aad")
  const parts = envelope.split(".")
  parts[4] = Buffer.from("x".repeat(Buffer.from(parts[4]!, "base64url").length)).toString("base64url")
  assert.throws(() => enc.decrypt(parts.join("."), "aad"), storageError)
})

test("a record moved to another key (different AAD) does not decrypt", () => {
  const enc = createEncryption({ current: "k1", keys: { k1: keyA } })
  const envelope = enc.encrypt("alice-token", "cred/github/alice")
  assert.throws(() => enc.decrypt(envelope, "cred/github/mallory"), storageError)
})

test("the wrong key does not decrypt", () => {
  const a = createEncryption({ current: "k1", keys: { k1: keyA } })
  const b = createEncryption({ current: "k1", keys: { k1: keyB } })
  assert.throws(() => b.decrypt(a.encrypt("x", "aad"), "aad"), storageError)
})

test("garbage and truncated envelopes fail cleanly, without leaking why", () => {
  const enc = createEncryption({ current: "k1", keys: { k1: keyA } })
  for (const bad of ["", "nope", "ck1.k1.a.b", "ck1.k1.a.b.c.d", "ck9.k1.a.b.c", "ck1.unknown.a.b.c"]) {
    assert.throws(() => enc.decrypt(bad, "aad"), storageError, JSON.stringify(bad))
  }
})

test("key rotation: new values use the current key, old values still decrypt", () => {
  const before = createEncryption({ current: "k1", keys: { k1: keyA } })
  const old = before.encrypt("old-secret", "aad")
  const after = createEncryption({ current: "k2", keys: { k1: keyA, k2: keyB } })
  assert.equal(after.decrypt(old, "aad"), "old-secret")
  assert.ok(after.encrypt("new-secret", "aad").startsWith("ck1.k2."))
  // once k1 is retired, its values stop decrypting
  const retired = createEncryption({ current: "k2", keys: { k2: keyB } })
  assert.throws(() => retired.decrypt(old, "aad"), storageError)
})

test("bad key configuration fails loudly at startup", () => {
  assert.throws(() => createEncryption({ current: "k1", keys: { k1: "c2hvcnQ=" } }), /32 bytes/)
  assert.throws(() => createEncryption({ current: "missing", keys: { k1: keyA } }), /not in "keys"/)
  assert.throws(() => createEncryption({ current: "a.b", keys: { "a.b": keyA } }), /letters, digits/)
})

// ------------------------------------------------------------------ encryptedStore

test("encryptedStore: the inner store never sees plaintext, and reads decrypt", async () => {
  const inner = memoryTokenStore()
  const store = encryptedStore(inner, createEncryption({ current: "k1", keys: { k1: keyA } }))
  await store.set("cred/github/u1", '{"accessToken":"gho_PLAINTEXT"}')
  const raw = await inner.get("cred/github/u1")
  assert.ok(raw && !raw.includes("gho_PLAINTEXT"))
  assert.equal(await store.get("cred/github/u1"), '{"accessToken":"gho_PLAINTEXT"}')
})

test("encryptedStore: temp values (PKCE verifiers) are encrypted too and still single-use", async () => {
  const inner = memoryTokenStore()
  const store = encryptedStore(inner, createEncryption({ current: "k1", keys: { k1: keyA } }))
  await store.putTemp("oauth-state/abc", "verifier-secret", 1000)
  assert.equal(await store.takeTemp("oauth-state/abc"), "verifier-secret")
  assert.equal(await store.takeTemp("oauth-state/abc"), undefined)
})

test("encryptedStore: swapping two users' records in the database is detected", async () => {
  const inner = memoryTokenStore()
  const store = encryptedStore(inner, createEncryption({ current: "k1", keys: { k1: keyA } }))
  await store.set("cred/github/alice", "alice-token")
  await store.set("cred/github/mallory", "mallory-token")
  await inner.set("cred/github/mallory", (await inner.get("cred/github/alice"))!) // attacker copies alice's record
  await assert.rejects(() => store.get("cred/github/mallory"), storageError)
})

test("encryptedStore: reading a missing key is just undefined", async () => {
  const store = encryptedStore(memoryTokenStore(), createEncryption({ current: "k1", keys: { k1: keyA } }))
  assert.equal(await store.get("nothing"), undefined)
})
