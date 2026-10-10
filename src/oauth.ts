import { createHash, randomBytes } from "node:crypto"
import type { AuthConfig, ConnectorDefinition, ActionDefinition } from "./define.js"
import { ConnectorKitError } from "./errors.js"
import { readCapped, type TokenSource } from "./execute.js"
import type { TokenStore } from "./store.js"

/** ADR-014. The host registers one OAuth app per provider and passes its details here. */
export interface OAuthClientConfig {
  clientId: string
  clientSecret?: string
  /** The callback URL YOUR app hosts and registered with the provider. */
  redirectUri: string
}

/** What is persisted per connection (as JSON, through the TokenStore). */
export interface StoredCredentials {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. Absent means the provider never expires this token. */
  expiresAt?: number
  scope?: string
}

export interface OAuthDeps {
  store: TokenStore
  fetch: typeof fetch
  timeoutMs: number
  now: () => number
  client: OAuthClientConfig
}

type OAuthAuth = Extract<AuthConfig, { type: "oauth2" }>

const STATE_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 60_000
const MAX_TOKEN_RESPONSE_BYTES = 64_000
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/

export const credentialKey = (connector: string, connectionId: string) =>
  `cred/${encodeURIComponent(connector)}/${encodeURIComponent(connectionId)}`
const stateKey = (state: string) => `oauth-state/${state}`

const fail = (code: ConnectorKitError["code"], message: string, retryable = false, raw?: { status: number; body: string }) =>
  new ConnectorKitError(code, message, { retryable, ...(raw && { raw }) })

/** Host misconfiguration, thrown synchronously to the developer (not a runtime condition for a model). */
export function oauthConfigOf(connector: ConnectorDefinition<Record<string, ActionDefinition>>): OAuthAuth {
  if (connector.auth.type !== "oauth2") throw new Error(`Connector "${connector.name}" does not use OAuth (auth.type is "${connector.auth.type}").`)
  return connector.auth
}

const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)

/** Credentials and codes must never travel over plain http (loopback is allowed for local development and tests). */
function assertSecureEndpoint(url: string, label: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error(`The ${label} must use https (got ${parsed.protocol}//${parsed.hostname}).`)
  }
}

const b64url = (buffer: Buffer) => buffer.toString("base64url")

// ---------------------------------------------------------------- start

export async function startAuth(
  deps: OAuthDeps,
  connector: ConnectorDefinition<Record<string, ActionDefinition>>,
  options: { connectionId: string; scopes?: string[] },
): Promise<{ url: string; state: string }> {
  const auth = oauthConfigOf(connector)
  assertSecureEndpoint(auth.authorizeUrl, "authorizeUrl")
  assertSecureEndpoint(auth.tokenUrl, "tokenUrl")
  if (!options.connectionId || options.connectionId.length > 256) throw new Error("connectionId must be a non-empty string of at most 256 characters.")

  const state = b64url(randomBytes(32))
  const usePkce = auth.pkce !== false
  const verifier = usePkce ? b64url(randomBytes(32)) : undefined

  // Server-side, single use, expiring. The browser only ever carries the opaque `state`.
  await deps.store.putTemp(
    stateKey(state),
    JSON.stringify({ connector: connector.name, connectionId: options.connectionId, ...(verifier && { verifier }) }),
    STATE_TTL_MS,
  )

  const url = new URL(auth.authorizeUrl)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", deps.client.clientId)
  url.searchParams.set("redirect_uri", deps.client.redirectUri)
  url.searchParams.set("state", state)
  const scopes = options.scopes ?? auth.scopes ?? []
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(auth.scopeSeparator ?? " "))
  if (verifier) {
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()))
    url.searchParams.set("code_challenge_method", "S256")
  }
  for (const [key, value] of Object.entries(auth.authorizeParams ?? {})) url.searchParams.set(key, value)
  return { url: url.toString(), state }
}

// ---------------------------------------------------------------- token endpoint

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

/** The provider says the refresh token is dead: the user has to reconnect. */
class RefreshRejected extends ConnectorKitError {}

async function tokenRequest(deps: OAuthDeps, auth: OAuthAuth, form: Record<string, string>, kind: "exchange" | "refresh"): Promise<TokenResponse> {
  const { client } = deps
  const body = new URLSearchParams(form)
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" })
  if (auth.clientAuth === "basic") {
    const credential = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`
    headers.set("Authorization", `Basic ${Buffer.from(credential).toString("base64")}`)
  } else {
    body.set("client_id", client.clientId)
    if (client.clientSecret) body.set("client_secret", client.clientSecret)
  }

  let response: Response
  try {
    response = await deps.fetch(auth.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(deps.timeoutMs) })
  } catch {
    // No cause: it could echo the request, which carries the client secret and the code.
    throw fail("upstream_error", "Could not reach the provider's token endpoint.", true)
  }

  let text: string
  try {
    const read = await readCapped(response, MAX_TOKEN_RESPONSE_BYTES)
    if (read.truncated) throw fail("upstream_error", "The provider's token response was too large.")
    text = read.text
  } catch (error) {
    if (error instanceof ConnectorKitError) throw error
    throw fail("upstream_error", "Could not read the provider's token response.", true)
  }

  let json: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
  } catch {
    // handled below
  }
  const raw = { status: response.status, body: text.slice(0, 2000) }
  // Providers report OAuth errors as {"error": "..."} and some (GitHub) do so with HTTP 200.
  // Only a short token is ever put into a message; free-form text stays in `raw`.
  const oauthError = typeof json?.error === "string" && /^[a-z_]{1,64}$/.test(json.error) ? json.error : undefined

  if (oauthError !== undefined) {
    if (["invalid_client", "unauthorized_client", "incorrect_client_credentials"].includes(oauthError)) {
      throw fail("upstream_error", "The provider rejected the OAuth client credentials. Check clientId and clientSecret.", false, raw)
    }
    if (kind === "refresh" && ["invalid_grant", "bad_refresh_token"].includes(oauthError)) {
      throw new RefreshRejected("auth_expired", "The connection is no longer valid (the refresh token was rejected). The user must connect again.", { retryable: false, raw })
    }
    throw fail("invalid_input", `The provider rejected the ${kind === "exchange" ? "authorization code" : "refresh"} (${oauthError}).${kind === "exchange" ? " Start the connection again." : ""}`, false, raw)
  }
  if (!response.ok) {
    throw fail("upstream_error", `The provider's token endpoint failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429, raw)
  }

  const accessToken = json?.access_token
  if (typeof accessToken !== "string" || accessToken === "") {
    throw fail("upstream_error", "The provider's token response did not contain an access token.", false, raw)
  }
  const expiresIn = Number(json?.expires_in)
  return {
    accessToken,
    ...(typeof json?.refresh_token === "string" && json.refresh_token !== "" && { refreshToken: json.refresh_token }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 && { expiresAt: deps.now() + expiresIn * 1000 }),
    ...(typeof json?.scope === "string" && { scope: json.scope }),
  }
}

// ---------------------------------------------------------------- finish

export async function finishAuth(
  deps: OAuthDeps,
  connector: ConnectorDefinition<Record<string, ActionDefinition>>,
  options: { code: string; state: string; expectedConnectionId?: string },
): Promise<{ connectionId: string; scope?: string }> {
  const auth = oauthConfigOf(connector)
  const unknown = () => fail("invalid_input", "This login attempt is unknown, expired, or was already used. Start the connection again.")
  if (typeof options.code !== "string" || options.code === "" || options.code.length > 4096) throw fail("invalid_input", "Missing authorization code.")
  if (typeof options.state !== "string" || !STATE_PATTERN.test(options.state)) throw unknown()

  // Consumed here, before anything else can fail: a state works once, whatever happens next.
  const stored = await deps.store.takeTemp(stateKey(options.state))
  if (stored === undefined) throw unknown()
  let record: { connector?: unknown; connectionId?: unknown; verifier?: unknown }
  try {
    record = JSON.parse(stored)
  } catch {
    throw fail("storage_error", "Stored login state was unreadable.")
  }
  if (record.connector !== connector.name || typeof record.connectionId !== "string") throw unknown()
  if (options.expectedConnectionId !== undefined && options.expectedConnectionId !== record.connectionId) {
    throw fail("invalid_input", "This login was started for a different user. Start the connection again.")
  }

  const tokens = await tokenRequest(
    deps,
    auth,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: deps.client.redirectUri,
      ...(typeof record.verifier === "string" && { code_verifier: record.verifier }),
    },
    "exchange",
  )
  const credentials: StoredCredentials = tokens
  await deps.store.set(credentialKey(connector.name, record.connectionId), JSON.stringify(credentials))
  return { connectionId: record.connectionId, ...(tokens.scope !== undefined && { scope: tokens.scope }) }
}

// ---------------------------------------------------------------- using stored tokens

function parseCredentials(raw: string): StoredCredentials {
  try {
    const value = JSON.parse(raw) as Partial<StoredCredentials>
    if (typeof value.accessToken === "string" && value.accessToken !== "") return value as StoredCredentials
  } catch {
    // fall through
  }
  throw fail("storage_error", "Stored credentials were unreadable. The user must connect again.")
}

/**
 * A token source backed by the TokenStore: reads the stored token and refreshes it when it is about
 * to expire, or when the provider just rejected it. Refreshes run under a lock and RE-READ the record
 * inside it, so callers that waited reuse the winner's result instead of refreshing again.
 */
export function oauthTokenSource(deps: OAuthDeps, connector: ConnectorDefinition<Record<string, ActionDefinition>>, connectionId: string): TokenSource {
  const auth = oauthConfigOf(connector)
  const key = credentialKey(connector.name, connectionId)

  const load = async (): Promise<StoredCredentials> => {
    const raw = await deps.store.get(key)
    if (raw === undefined) {
      throw fail("not_connected", `No ${connector.name} account is connected for this user. Ask the user to connect it first.`)
    }
    return parseCredentials(raw)
  }
  const isFresh = (c: StoredCredentials) => c.expiresAt === undefined || c.expiresAt - deps.now() > REFRESH_SKEW_MS
  const cannotRefresh = () => fail("auth_expired", "The stored token is expired or was rejected and cannot be refreshed. The user must connect again.")

  return {
    refreshable: true,
    async get(options) {
      const rejected = options?.rejected
      const needsRefresh = (c: StoredCredentials) => !isFresh(c) || (rejected !== undefined && c.accessToken === rejected)

      const first = await load()
      if (!needsRefresh(first)) return first.accessToken // fresh, or someone else already replaced the rejected token

      return deps.store.withLock(key, async () => {
        const current = await load() // re-read INSIDE the lock: a caller ahead of us may have refreshed already
        if (!needsRefresh(current)) return current.accessToken
        if (current.refreshToken === undefined) throw cannotRefresh()

        let tokens: TokenResponse
        try {
          tokens = await tokenRequest(deps, auth, { grant_type: "refresh_token", refresh_token: current.refreshToken }, "refresh")
        } catch (error) {
          if (error instanceof RefreshRejected) await deps.store.delete(key) // dead for good; a transient failure keeps the record
          throw error
        }
        const updated: StoredCredentials = {
          accessToken: tokens.accessToken,
          // Some providers rotate the refresh token, some keep it: never lose the one we still have.
          refreshToken: tokens.refreshToken ?? current.refreshToken,
          ...(tokens.expiresAt !== undefined && { expiresAt: tokens.expiresAt }),
          ...((tokens.scope ?? current.scope) !== undefined && { scope: (tokens.scope ?? current.scope)! }),
        }
        await deps.store.set(key, JSON.stringify(updated))
        return updated.accessToken
      })
    },
  }
}
