// The behavior EVERY TokenStore must have. Run against each implementation (memory here, Postgres in
// postgres-store.test.ts), so they cannot drift apart. If you write your own store, run this on it.
import assert from "node:assert/strict"
import { test } from "node:test"
import { memoryTokenStore, type TokenStore } from "./index.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function runStoreContract(label: string, make: () => TokenStore | Promise<TokenStore>): void {
  const t = (name: string, fn: (store: TokenStore) => Promise<void>) => test(`[${label}] ${name}`, async () => fn(await make()))

  t("get / set / overwrite / delete", async (store) => {
    assert.equal(await store.get("a"), undefined)
    await store.set("a", "1")
    await store.set("a", "2")
    assert.equal(await store.get("a"), "2")
    await store.delete("a")
    assert.equal(await store.get("a"), undefined)
    await store.delete("a") // deleting nothing is fine
  })

  t("keys are independent", async (store) => {
    await store.set("cred/x/alice", "A")
    await store.set("cred/x/bob", "B")
    assert.equal(await store.get("cred/x/alice"), "A")
    assert.equal(await store.get("cred/x/bob"), "B")
  })

  t("values round-trip exactly: unicode, newlines, quotes, large", async (store) => {
    for (const value of ["héllo 🌍", "line1\nline2\r\n", `{"a":"it's \\"quoted\\""}`, "x".repeat(200_000), ""]) {
      await store.set("v", value)
      assert.equal(await store.get("v"), value)
    }
  })

  t("a temp value is taken exactly once", async (store) => {
    await store.putTemp("state/1", "payload", 5_000)
    assert.equal(await store.takeTemp("state/1"), "payload")
    assert.equal(await store.takeTemp("state/1"), undefined)
  })

  t("ten simultaneous takes: exactly one wins", async (store) => {
    await store.putTemp("state/race", "payload", 5_000)
    const results = await Promise.all(Array.from({ length: 10 }, () => store.takeTemp("state/race")))
    assert.deepEqual(results.filter((r) => r !== undefined), ["payload"])
  })

  t("a temp value expires, and taking an expired one still consumes it", async (store) => {
    await store.putTemp("state/ttl", "payload", 60)
    await sleep(200)
    assert.equal(await store.takeTemp("state/ttl"), undefined)
    assert.equal(await store.takeTemp("state/ttl"), undefined)
  })

  t("putTemp again replaces the value", async (store) => {
    await store.putTemp("state/re", "one", 5_000)
    await store.putTemp("state/re", "two", 5_000)
    assert.equal(await store.takeTemp("state/re"), "two")
  })

  t("withLock gives mutual exclusion: 20 concurrent read-modify-writes lose no update", async (store) => {
    await store.set("counter", "0")
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.withLock("counter", async () => {
          const current = Number(await store.get("counter"))
          await sleep(1) // a window in which an unlocked caller would read the same value
          await store.set("counter", String(current + 1))
        }),
      ),
    )
    assert.equal(await store.get("counter"), "20")
  })

  t("withLock returns the function's value and releases when it throws", async (store) => {
    assert.equal(await store.withLock("k", async () => 42), 42)
    await assert.rejects(() => store.withLock("k", async () => { throw new Error("boom") }), /boom/)
    assert.equal(await store.withLock("k", async () => "still works"), "still works")
  })

  t("locks on different keys do not block each other", async (store) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const a = store.withLock("lock-a", () => held)
    assert.equal(await store.withLock("lock-b", async () => "b-done"), "b-done")
    release()
    await a
  })
}

runStoreContract("memory", () => memoryTokenStore())
