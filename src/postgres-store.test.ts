// Runs against a REAL Postgres. Skipped unless DATABASE_URL is set. CI provides one; locally:
//   docker compose up -d
//   DATABASE_URL=postgres://connectorkit:connectorkit@localhost:5432/connectorkit pnpm test
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import pg from "pg"
import { ConnectorKitError, postgresTokenStore } from "./index.js"
import { runStoreContract } from "./store-contract.test.js"

const url = process.env.DATABASE_URL
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

if (!url) {
  if (process.env.REQUIRE_POSTGRES) {
    // CI sets REQUIRE_POSTGRES so a missing database is a FAILURE, never a silent skip that looks green.
    test("[postgres] DATABASE_URL is required in this environment", () => assert.fail("REQUIRE_POSTGRES is set but DATABASE_URL is not"))
  } else {
    test("[postgres] skipped: set DATABASE_URL to run the Postgres store tests", { skip: "set DATABASE_URL" }, () => {})
  }
} else {
  const table = `ck_test_${randomBytes(6).toString("hex")}`
  const pool = new pg.Pool({ connectionString: url, max: 20 })
  const make = () => postgresTokenStore(pool, { table })

  before(async () => {
    await make().migrate()
  })
  after(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`)
    await pool.end()
  })

  // The same contract the memory store passes.
  runStoreContract("postgres", make)

  test("[postgres] migrate() is idempotent and schemaSql() names the table", async () => {
    const store = make()
    await store.migrate()
    await store.migrate()
    assert.ok(store.schemaSql().includes(`"${table}"`))
  })

  test("[postgres] a table name that could inject SQL is rejected", () => {
    for (const bad of ['x"; DROP TABLE y; --', "a b", "1abc", "", "a".repeat(64)]) {
      assert.throws(() => postgresTokenStore(pool, { table: bad }), /Invalid table name/, JSON.stringify(bad))
    }
  })

  test("[postgres] TWO servers sharing one database exclude each other (the cross-process lock)", async () => {
    const serverA = make()
    const serverB = make() // a separate store instance = a separate process, as far as the lock is concerned
    await serverA.set("shared-counter", "0")
    const bump = (store: ReturnType<typeof make>) =>
      store.withLock("shared-counter", async () => {
        const current = Number(await store.get("shared-counter"))
        await sleep(2)
        await store.set("shared-counter", String(current + 1))
      })
    await Promise.all([...Array.from({ length: 10 }, () => bump(serverA)), ...Array.from({ length: 10 }, () => bump(serverB))])
    assert.equal(await serverA.get("shared-counter"), "20")
  })

  test("[postgres] a crashed holder's lease expires and another server takes over", async () => {
    const store = postgresTokenStore(pool, { table, lockWaitMs: 2_000 })
    // A holder that died without releasing: its lease ended one second ago.
    await pool.query(`INSERT INTO "${table}" (key, value, expires_at) VALUES ('lock/crashed', 'dead-owner', now() - interval '1 second')`)
    assert.equal(await store.withLock("crashed", async () => "took over"), "took over")
  })

  test("[postgres] a live lease blocks others until the wait limit, then fails clearly", async () => {
    const store = postgresTokenStore(pool, { table, lockWaitMs: 250 })
    await pool.query(`INSERT INTO "${table}" (key, value, expires_at) VALUES ('lock/busy', 'other-server', now() + interval '1 minute')`)
    await assert.rejects(
      () => store.withLock("busy", async () => "never"),
      (e: unknown) => e instanceof ConnectorKitError && e.code === "storage_error" && e.retryable,
    )
    await pool.query(`DELETE FROM "${table}" WHERE key = 'lock/busy'`)
  })

  test("[postgres] a holder whose lease expired does not delete its successor's lock", async () => {
    const slow = postgresTokenStore(pool, { table, leaseMs: 60, lockWaitMs: 2_000 })
    const next = postgresTokenStore(pool, { table, leaseMs: 60_000, lockWaitMs: 2_000 })
    let nextHoldsLock!: () => void
    const nextAcquired = new Promise<void>((resolve) => (nextHoldsLock = resolve))
    let finishNext!: () => void
    const nextMayFinish = new Promise<void>((resolve) => (finishNext = resolve))

    const slowRun = slow.withLock("handoff", async () => {
      await sleep(150) // outlives its 60 ms lease
      await nextAcquired // ...and by now `next` has taken the lock over
    })
    await sleep(100)
    const nextRun = next.withLock("handoff", async () => {
      nextHoldsLock()
      await nextMayFinish
    })
    await slowRun // `slow` releases here: it must not remove next's lock
    const row = await pool.query(`SELECT 1 FROM "${table}" WHERE key = 'lock/handoff'`)
    assert.equal(row.rowCount, 1, "the successor's lock must still be held")
    finishNext()
    await nextRun
  })

  test("[postgres] putTemp sweeps expired rows so the table does not grow forever", async () => {
    const store = make()
    await pool.query(`INSERT INTO "${table}" (key, value, expires_at) VALUES ('old/junk', 'x', now() - interval '1 hour')`)
    await store.putTemp("fresh/one", "y", 5_000)
    const junk = await pool.query(`SELECT 1 FROM "${table}" WHERE key = 'old/junk'`)
    assert.equal(junk.rowCount, 0)
    await store.takeTemp("fresh/one")
  })

  test("[postgres] expiry uses the database clock, and a permanent value never expires", async () => {
    const store = make()
    await store.set("perm", "forever")
    await sleep(50)
    assert.equal(await store.get("perm"), "forever")
    await pool.query(`INSERT INTO "${table}" (key, value, expires_at) VALUES ('expired/get', 'x', now() - interval '1 second')`)
    assert.equal(await store.get("expired/get"), undefined) // get() never returns an expired row
  })
}
