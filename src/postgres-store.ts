import { randomBytes } from "node:crypto"
import { ConnectorKitError } from "./errors.js"
import type { TokenStore } from "./store.js"

/**
 * The only thing the Postgres store needs from a driver. `pg.Pool` and `pg.Client` already fit;
 * other drivers need a three-line adapter. No driver is bundled (the library stays dependency-light).
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface PostgresStoreOptions {
  /** Table name (letters, digits, underscore). Default "connector_kit_kv". */
  table?: string
  /** How long a lock may be held before another server may take it over (covers a crashed holder). Default 120 000 ms. */
  leaseMs?: number
  /** How long to wait for a lock before giving up. Default 60 000 ms. */
  lockWaitMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export type PostgresTokenStore = TokenStore & {
  /** `CREATE TABLE IF NOT EXISTS`. Safe to call on every start; or run `schemaSql()` in your own migrations. */
  migrate(): Promise<void>
  /** The SQL `migrate()` runs, for people who manage migrations themselves. */
  schemaSql(): string
}

/**
 * A durable TokenStore on Postgres (ADR-014). Pair it with `encryptedStore()`: the table then only
 * ever holds ciphertext.
 *
 * - Expiry uses the DATABASE's clock, so servers with drifting clocks still agree.
 * - `takeTemp` is a single `DELETE ... RETURNING`, which Postgres makes atomic: two simultaneous
 *   callbacks cannot both receive the same OAuth state.
 * - `withLock` works ACROSS servers using a lease row: one atomic conditional INSERT claims it and
 *   no database connection is held while waiting. (A connection-bound advisory lock would let waiters
 *   exhaust the pool and starve the lock holder, and does not survive transaction-mode poolers.)
 *   A holder that crashes loses the lease after `leaseMs`.
 */
export function postgresTokenStore(db: PgQueryable, options: PostgresStoreOptions = {}): PostgresTokenStore {
  const name = options.table ?? "connector_kit_kv"
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid table name "${name}": use letters, digits and underscores.`)
  const t = `"${name}"`
  const leaseMs = options.leaseMs ?? 120_000
  const lockWaitMs = options.lockWaitMs ?? 60_000
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const schemaSql = () => `CREATE TABLE IF NOT EXISTS ${t} (
  key text PRIMARY KEY,
  value text NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS "${name}_expires_at_idx" ON ${t} (expires_at) WHERE expires_at IS NOT NULL;`

  const live = "(expires_at IS NULL OR expires_at > now())"

  return {
    schemaSql,
    async migrate() {
      for (const statement of schemaSql().split(";\n").filter((s) => s.trim())) await db.query(statement)
    },

    async get(key) {
      const result = await db.query(`SELECT value FROM ${t} WHERE key = $1 AND ${live}`, [key])
      return result.rows[0]?.value as string | undefined
    },
    async set(key, value) {
      await db.query(`INSERT INTO ${t} (key, value, expires_at) VALUES ($1, $2, NULL) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`, [key, value])
    },
    async delete(key) {
      await db.query(`DELETE FROM ${t} WHERE key = $1`, [key])
    },

    async putTemp(key, value, ttlMs) {
      await db.query(`DELETE FROM ${t} WHERE expires_at IS NOT NULL AND expires_at <= now()`) // keep the table from growing
      await db.query(
        `INSERT INTO ${t} (key, value, expires_at) VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, value, ttlMs],
      )
    },
    async takeTemp(key) {
      // One statement = atomic. The row is removed even when expired, so a state works at most once.
      const result = await db.query(`DELETE FROM ${t} WHERE key = $1 RETURNING value, (expires_at IS NULL OR expires_at > now()) AS valid`, [key])
      const row = result.rows[0]
      return row && row.valid === true ? (row.value as string) : undefined
    },

    async withLock(key, fn) {
      const lockKey = `lock/${key}`
      const owner = randomBytes(16).toString("hex")
      const deadline = Date.now() + lockWaitMs
      let delay = 10
      for (;;) {
        // Claim it if nobody holds it, or take it over if the holder's lease has expired. Atomic.
        const claim = await db.query(
          `INSERT INTO ${t} (key, value, expires_at) VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
           WHERE ${t}.expires_at IS NOT NULL AND ${t}.expires_at <= now()`,
          [lockKey, owner, leaseMs],
        )
        if ((claim.rowCount ?? 0) > 0) break
        if (Date.now() >= deadline) {
          throw new ConnectorKitError("storage_error", "Timed out waiting for another request to finish refreshing this connection.", { retryable: true })
        }
        await sleep(delay + Math.floor(Math.random() * delay)) // jittered, growing: waiters do not stampede
        delay = Math.min(delay * 2, 200)
      }
      try {
        return await fn()
      } finally {
        // Release only if we still own it (our lease may have expired and been taken over).
        await db.query(`DELETE FROM ${t} WHERE key = $1 AND value = $2`, [lockKey, owner])
      }
    },
  }
}
