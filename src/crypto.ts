import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { ConnectorKitError } from "./errors.js"
import type { TokenStore } from "./store.js"

/**
 * Encryption at rest for stored credentials (ADR-014): AES-256-GCM with a fresh random nonce per
 * value. The store KEY is bound into the ciphertext as additional authenticated data, so a record
 * copied to another connection's key will not decrypt (an attacker with database write access cannot
 * swap one user's tokens for another's).
 *
 * The encryption key is supplied by the HOST and must not live in the same database as the data.
 * Keys are identified by id so they can be rotated: new values use `current`; old ones still decrypt.
 */
export interface EncryptionConfig {
  /** Id of the key used for new values. */
  current: string
  /** Key id -> 32 bytes, as raw bytes or a base64 string (see `generateEncryptionKey`). */
  keys: Record<string, string | Uint8Array>
}

export interface Encryption {
  encrypt(plaintext: string, aad: string): string
  decrypt(envelope: string, aad: string): string
}

const VERSION = "ck1"
const b64 = (buffer: Uint8Array) => Buffer.from(buffer).toString("base64url")

/** A fresh random 256-bit key, base64-encoded. Store it in your secret manager, never next to the data. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64")
}

export function createEncryption(config: EncryptionConfig): Encryption {
  const keys = new Map<string, Buffer>()
  for (const [id, material] of Object.entries(config.keys)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Encryption key id "${id}" may only contain letters, digits, "_" and "-".`)
    const key = typeof material === "string" ? Buffer.from(material, "base64") : Buffer.from(material)
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be exactly 32 bytes (got ${key.length}). Use generateEncryptionKey().`)
    keys.set(id, key)
  }
  const current = keys.get(config.current)
  if (!current) throw new Error(`Encryption "current" key id "${config.current}" is not in "keys".`)

  const failure = () =>
    new ConnectorKitError("storage_error", "Stored credentials could not be decrypted (wrong key, tampering, or corrupted data).", { retryable: false })

  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", current, iv)
      cipher.setAAD(Buffer.from(aad))
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return [VERSION, config.current, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(".")
    },
    decrypt(envelope, aad) {
      const [version, keyId, iv, tag, ciphertext, ...extra] = envelope.split(".")
      const key = keyId === undefined ? undefined : keys.get(keyId)
      if (version !== VERSION || !key || !iv || !tag || ciphertext === undefined || extra.length > 0) throw failure()
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
        decipher.setAAD(Buffer.from(aad))
        decipher.setAuthTag(Buffer.from(tag, "base64url"))
        return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")
      } catch {
        throw failure() // never leak why: wrong key, wrong AAD and tampering look the same
      }
    },
  }
}

/** Wrap any TokenStore so everything it persists is encrypted. Keys (not values) stay readable. */
export function encryptedStore(inner: TokenStore, encryption: Encryption): TokenStore {
  const open = (key: string, value: string | undefined) => (value === undefined ? undefined : encryption.decrypt(value, key))
  return {
    async get(key) {
      return open(key, await inner.get(key))
    },
    set: (key, value) => inner.set(key, encryption.encrypt(value, key)),
    delete: (key) => inner.delete(key),
    putTemp: (key, value, ttlMs) => inner.putTemp(key, encryption.encrypt(value, key), ttlMs),
    async takeTemp(key) {
      return open(key, await inner.takeTemp(key))
    },
    withLock: (key, fn) => inner.withLock(key, fn),
  }
}
