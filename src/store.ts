/**
 * Where credentials and short-lived OAuth state live (ADR-014).
 *
 * Deliberately a dumb string key-value interface: the kit serializes values itself, and the
 * encryption wrapper (`encryptedStore`) can sit in front of ANY implementation. Implement it over
 * Postgres, Redis, DynamoDB, a file, ... The three behaviors that need care are marked below.
 */
export interface TokenStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>

  /** Store a value that expires on its own (OAuth `state` / PKCE verifier). */
  putTemp(key: string, value: string, ttlMs: number): Promise<void>
  /**
   * Atomically read AND delete a temp value: it can be used exactly once, and never after its
   * ttl. This is what makes an OAuth `state` single-use; two concurrent callbacks must not both win.
   */
  takeTemp(key: string): Promise<string | undefined>

  /**
   * Run `fn` while holding a lock on `key`, so only one caller at a time refreshes a connection's
   * token (two refreshes at once can invalidate a rotating refresh token). A store shared by several
   * processes must make this lock work ACROSS processes (e.g. a Postgres advisory lock); the in-memory
   * store only protects within one process.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}

/**
 * In-process store for trying the library out and for tests. Nothing survives a restart and the
 * lock only works within this process: use a real store in production.
 */
export function memoryTokenStore(options: { now?: () => number } = {}): TokenStore {
  const now = options.now ?? Date.now
  const values = new Map<string, string>()
  const temps = new Map<string, { value: string; expiresAt: number }>()
  const lockTails = new Map<string, Promise<void>>()

  return {
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
    async putTemp(key, value, ttlMs) {
      temps.set(key, { value, expiresAt: now() + ttlMs })
    },
    async takeTemp(key) {
      const entry = temps.get(key)
      temps.delete(key) // single use, even when expired
      return entry && entry.expiresAt > now() ? entry.value : undefined
    },
    async withLock(key, fn) {
      // A per-key queue: each caller waits for the previous holder's release.
      const previous = lockTails.get(key) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const tail = previous.then(() => held)
      lockTails.set(key, tail)
      await previous
      try {
        return await fn()
      } finally {
        release()
        if (lockTails.get(key) === tail) lockTails.delete(key)
      }
    },
  }
}
