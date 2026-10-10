import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { z } from "zod"
import { createEncryption, encryptedStore, generateEncryptionKey } from "./crypto.js"
import { ConnectorKitError, createConnectorKit, defineConnector, memoryTokenStore, type KitOptions, type TokenStore } from "./index.js"

const acme = defineConnector({
  name: "acme",
  baseUrl: "https://api.acme.test",
  auth: {
    type: "oauth2",
    authorizeUrl: "https://auth.acme.test/authorize",
    tokenUrl: "https://auth.acme.test/token",
    scopes: ["read", "write"],
  },
  actions: {
    "items.get": { description: "Get an item.", method: "GET", path: "/items/{id}", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), effect: "read" },
    "items.create": { description: "Create an item.", method: "POST", path: "/items", input: z.object({ title: z.string() }), output: z.object({ id: z.string() }), effect: "write" },
  },
})

const CLIENT = { clientId: "client_123", clientSecret: "client_SECRET_456", redirectUri: "https://app.test/callback" }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const kitError = (code: string, extra?: (e: ConnectorKitError) => boolean) => (e: unknown) => e instanceof ConnectorKitError && e.code === code && (extra?.(e) ?? true)

interface Seen {
  url: string
  init: RequestInit
  form: URLSearchParams
}

/** A fake provider: `token` answers the token endpoint, `api` answers API calls. */
function setup(handlers: { token?: (form: URLSearchParams, seen: Seen) => Response | Promise<Response>; api?: (token: string, seen: Seen) => Response | Promise<Response> } = {}, options: KitOptions = {}) {
  const tokenCalls: Seen[] = []
  const apiCalls: Seen[] = []
  const clock = { now: 1_000_000 }
  const store = options.tokenStore ?? memoryTokenStore({ now: () => clock.now })
  const fetchMock = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "")
    const seen = { url, init: init ?? {}, form }
    if (url.startsWith("https://auth.acme.test/token")) {
      tokenCalls.push(seen)
      return handlers.token ? handlers.token(form, seen) : json({ access_token: "at_default" })
    }
    apiCalls.push(seen)
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
    return handlers.api ? handlers.api(bearer, seen) : json({ id: "1" })
  }) as typeof fetch
  const kit = createConnectorKit({ retry: { maxRetries: 0 }, oauth: { acme: CLIENT }, tokenStore: store, now: () => clock.now, ...options, fetch: fetchMock })
  return { kit, store, clock, tokenCalls, apiCalls, conn: kit.connect(acme, { connectionId: "user_1" }) }
}

async function connectUser(ctx: ReturnType<typeof setup>, token = { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }, connectionId = "user_1") {
  const { state } = await ctx.kit.startAuth(acme, { connectionId })
  return { state, result: await ctx.kit.finishAuth(acme, { code: "code_abc", state }) , token }
}

// ============================================================ startAuth

test("startAuth builds the provider URL with state, scopes and a PKCE S256 challenge", async () => {
  const { kit, store } = setup()
  const { url, state } = await kit.startAuth(acme, { connectionId: "user_1" })
  const u = new URL(url)
  assert.equal(`${u.origin}${u.pathname}`, "https://auth.acme.test/authorize")
  assert.equal(u.searchParams.get("response_type"), "code")
  assert.equal(u.searchParams.get("client_id"), CLIENT.clientId)
  assert.equal(u.searchParams.get("redirect_uri"), CLIENT.redirectUri)
  assert.equal(u.searchParams.get("state"), state)
  assert.equal(u.searchParams.get("scope"), "read write")
  assert.equal(u.searchParams.get("code_challenge_method"), "S256")
  assert.ok(!url.includes(CLIENT.clientSecret), "the client secret must never be in a URL")

  // The challenge is the S256 hash of a verifier that only the server knows.
  const record = JSON.parse((await store.takeTemp(`oauth-state/${state}`))!)
  assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update(record.verifier).digest("base64url"))
  assert.equal(record.connectionId, "user_1")
  assert.notEqual(u.searchParams.get("code_challenge"), record.verifier)
})

test("startAuth: states are unpredictable and scopes can be overridden", async () => {
  const { kit } = setup()
  const a = await kit.startAuth(acme, { connectionId: "u" })
  const b = await kit.startAuth(acme, { connectionId: "u", scopes: ["admin"] })
  assert.notEqual(a.state, b.state)
  assert.ok(a.state.length >= 40)
  assert.equal(new URL(b.url).searchParams.get("scope"), "admin")
})

test("pkce: false omits the challenge", async () => {
  const noPkce = defineConnector({ ...acme, name: "nopkce", auth: { ...acme.auth, type: "oauth2", authorizeUrl: "https://auth.acme.test/authorize", tokenUrl: "https://auth.acme.test/token", pkce: false } })
  const kit = createConnectorKit({ tokenStore: memoryTokenStore(), oauth: { nopkce: CLIENT } })
  const { url } = await kit.startAuth(noPkce, { connectionId: "u" })
  assert.equal(new URL(url).searchParams.get("code_challenge"), null)
})

test("startAuth tells the developer what is missing", async () => {
  await assert.rejects(() => createConnectorKit({ oauth: { acme: CLIENT } }).startAuth(acme, { connectionId: "u" }), /tokenStore/)
  await assert.rejects(() => createConnectorKit({ tokenStore: memoryTokenStore() }).startAuth(acme, { connectionId: "u" }), /No OAuth app configured for "acme"/)
  const bearerOnly = defineConnector({ name: "plain", baseUrl: "https://x.test", auth: { type: "bearer" }, actions: {} })
  await assert.rejects(() => setup().kit.startAuth(bearerOnly, { connectionId: "u" }), /does not use OAuth/)
})

test("token and authorize endpoints must be https (loopback excepted)", async () => {
  const insecure = defineConnector({ name: "acme", baseUrl: "https://x.test", auth: { type: "oauth2", authorizeUrl: "https://a.test/a", tokenUrl: "http://a.test/token" }, actions: {} })
  await assert.rejects(() => setup().kit.startAuth(insecure, { connectionId: "u" }), /must use https/)
  const loopback = defineConnector({ name: "acme", baseUrl: "https://x.test", auth: { type: "oauth2", authorizeUrl: "http://127.0.0.1:9/a", tokenUrl: "http://localhost:9/token" }, actions: {} })
  await setup().kit.startAuth(loopback, { connectionId: "u" })
})

// ============================================================ finishAuth

test("finishAuth exchanges the code (with the PKCE verifier) and stores the tokens", async () => {
  const ctx = setup({ token: () => json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600, scope: "read" }) })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "user_1" })
  const result = await ctx.kit.finishAuth(acme, { code: "code_abc", state })

  assert.deepEqual(result, { connectionId: "user_1", scope: "read" })
  const sent = ctx.tokenCalls[0]!
  assert.equal(sent.form.get("grant_type"), "authorization_code")
  assert.equal(sent.form.get("code"), "code_abc")
  assert.equal(sent.form.get("redirect_uri"), CLIENT.redirectUri)
  assert.equal(sent.form.get("client_id"), CLIENT.clientId)
  assert.equal(sent.form.get("client_secret"), CLIENT.clientSecret)
  assert.ok((sent.form.get("code_verifier") ?? "").length >= 43)
  assert.equal(new Headers(sent.init.headers).get("accept"), "application/json")

  const stored = JSON.parse((await ctx.store.get("cred/acme/user_1"))!)
  assert.deepEqual(stored, { accessToken: "at_1", refreshToken: "rt_1", expiresAt: ctx.clock.now + 3_600_000, scope: "read" })
})

test("clientAuth: 'basic' sends the secret in the Authorization header, not the body", async () => {
  const basic = defineConnector({ ...acme, auth: { type: "oauth2", authorizeUrl: "https://auth.acme.test/authorize", tokenUrl: "https://auth.acme.test/token", clientAuth: "basic" } })
  const ctx = setup()
  const { state } = await ctx.kit.startAuth(basic, { connectionId: "u" })
  await ctx.kit.finishAuth(basic, { code: "c", state })
  const sent = ctx.tokenCalls[0]!
  assert.equal(new Headers(sent.init.headers).get("authorization"), `Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString("base64")}`)
  assert.equal(sent.form.get("client_secret"), null)
})

test("an unknown, forged or malformed state is rejected without any network call", async () => {
  const ctx = setup()
  for (const state of ["", "short", "x".repeat(40), "../../etc/passwd", "a b c".padEnd(40, "d")]) {
    await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state }), kitError("invalid_input"), JSON.stringify(state))
  }
  assert.equal(ctx.tokenCalls.length, 0)
})

test("a state can be used only once (replaying the callback fails)", async () => {
  const ctx = setup({ token: () => json({ access_token: "at_1" }) })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  await ctx.kit.finishAuth(acme, { code: "c", state })
  await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state }), kitError("invalid_input", (e) => e.message.includes("already used")))
  assert.equal(ctx.tokenCalls.length, 1)
})

test("two simultaneous callbacks with the same state: exactly one succeeds", async () => {
  const ctx = setup({ token: async () => (await tick(), json({ access_token: "at_1" })) })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  const results = await Promise.allSettled([ctx.kit.finishAuth(acme, { code: "c", state }), ctx.kit.finishAuth(acme, { code: "c", state })])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.equal(ctx.tokenCalls.length, 1)
})

test("a state expires after 10 minutes", async () => {
  const ctx = setup()
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  ctx.clock.now += 10 * 60 * 1000 + 1
  await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state }), kitError("invalid_input"))
  assert.equal(ctx.tokenCalls.length, 0)
})

test("expectedConnectionId: a login started for another user is rejected, and the state is burned", async () => {
  const ctx = setup()
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "alice" })
  await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state, expectedConnectionId: "mallory" }), kitError("invalid_input", (e) => e.message.includes("different user")))
  await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state, expectedConnectionId: "alice" }), kitError("invalid_input"))
  assert.equal(ctx.tokenCalls.length, 0)
  assert.equal(await ctx.store.get("cred/acme/alice"), undefined)
})

test("a state issued for one connector cannot complete another's login", async () => {
  const other = defineConnector({ ...acme, name: "other" })
  const ctx = setup({}, { oauth: { acme: CLIENT, other: CLIENT } })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  await assert.rejects(() => ctx.kit.finishAuth(other, { code: "c", state }), kitError("invalid_input"))
})

test("a rejected code is invalid_input; provider free text stays in raw, never in the message", async () => {
  const ctx = setup({ token: () => json({ error: "bad_verification_code", error_description: "internal detail SECRET-XYZ" }) }) // GitHub answers errors with HTTP 200
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  await assert.rejects(
    () => ctx.kit.finishAuth(acme, { code: "c", state }),
    (e: unknown) => {
      assert.ok(e instanceof ConnectorKitError)
      assert.equal(e.code, "invalid_input")
      assert.ok(e.message.includes("bad_verification_code"))
      assert.ok(!e.message.includes("SECRET-XYZ"))
      assert.ok(e.raw?.body.includes("SECRET-XYZ"))
      assert.ok(!JSON.stringify(e).includes(CLIENT.clientSecret))
      return true
    },
  )
})

test("bad client credentials are reported as a configuration problem", async () => {
  const ctx = setup({ token: () => json({ error: "invalid_client" }, 401) })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
  await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state }), kitError("upstream_error", (e) => !e.retryable && e.message.includes("clientSecret")))
})

test("token endpoint failures: 5xx, no access_token, not JSON, unreachable", async () => {
  for (const respond of [() => json({}, 503), () => json({ token_type: "bearer" }), () => new Response("<html>", { status: 200 }), () => { throw new Error("ECONNREFUSED secret-in-error") }]) {
    const ctx = setup({ token: respond })
    const { state } = await ctx.kit.startAuth(acme, { connectionId: "u" })
    await assert.rejects(() => ctx.kit.finishAuth(acme, { code: "c", state }), kitError("upstream_error", (e) => !e.message.includes("secret-in-error")))
    assert.equal(await ctx.store.get("cred/acme/u"), undefined)
  }
})

// ============================================================ using the stored token

test("a connection that was never connected is not_connected, with no network call", async () => {
  const ctx = setup()
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("not_connected", (e) => !e.retryable))
  assert.equal(ctx.apiCalls.length, 0)
})

test("connect() without credentials needs an OAuth connector, a store and a client", () => {
  const plain = defineConnector({ name: "plain", baseUrl: "https://x.test", auth: { type: "bearer" }, actions: {} })
  assert.throws(() => setup().kit.connect(plain, { connectionId: "u" }), /needs credentials/)
  assert.throws(() => createConnectorKit({ oauth: { acme: CLIENT } }).connect(acme, { connectionId: "u" }), /tokenStore/)
})

test("a stored, fresh token is sent as the Bearer token", async () => {
  const ctx = setup({ token: () => json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }) })
  await connectUser(ctx)
  await ctx.conn.execute("items.get", { id: "1" })
  assert.equal(new Headers(ctx.apiCalls[0]!.init.headers).get("authorization"), "Bearer at_1")
  assert.equal(ctx.tokenCalls.length, 1) // only the code exchange: no refresh needed
})

test("an expired token is refreshed once and the new tokens are saved (rotating refresh token)", async () => {
  let n = 0
  const ctx = setup({ token: (form) => (form.get("grant_type") === "refresh_token" ? json({ access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 }) : (n++, json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }))) })
  await connectUser(ctx)
  ctx.clock.now += 3_600_000 + 1
  await ctx.conn.execute("items.get", { id: "1" })

  const refresh = ctx.tokenCalls[1]!
  assert.equal(refresh.form.get("grant_type"), "refresh_token")
  assert.equal(refresh.form.get("refresh_token"), "rt_1")
  assert.equal(new Headers(ctx.apiCalls[0]!.init.headers).get("authorization"), "Bearer at_2")
  assert.equal(JSON.parse((await ctx.store.get("cred/acme/user_1"))!).refreshToken, "rt_2")
})

test("a provider that does not rotate refresh tokens keeps the one we have", async () => {
  const ctx = setup({ token: (form) => json(form.get("grant_type") === "refresh_token" ? { access_token: "at_2", expires_in: 3600 } : { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }) })
  await connectUser(ctx)
  ctx.clock.now += 3_600_000
  await ctx.conn.execute("items.get", { id: "1" })
  assert.equal(JSON.parse((await ctx.store.get("cred/acme/user_1"))!).refreshToken, "rt_1")
})

test("a token within 60 seconds of expiry is refreshed early", async () => {
  const ctx = setup({ token: (form) => json(form.get("grant_type") === "refresh_token" ? { access_token: "at_2", expires_in: 3600 } : { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }) })
  await connectUser(ctx)
  ctx.clock.now += 3_600_000 - 30_000
  await ctx.conn.execute("items.get", { id: "1" })
  assert.equal(ctx.tokenCalls.length, 2)
})

test("THE RACE: ten simultaneous calls with an expired token cause exactly one refresh", async () => {
  const ctx = setup({
    token: async (form) => {
      if (form.get("grant_type") !== "refresh_token") return json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 })
      await tick() // slow provider: gives every other caller time to pile up
      await tick()
      return json({ access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 })
    },
  })
  await connectUser(ctx)
  ctx.clock.now += 3_600_001
  await Promise.all(Array.from({ length: 10 }, () => ctx.conn.execute("items.get", { id: "1" })))

  assert.equal(ctx.tokenCalls.filter((c) => c.form.get("grant_type") === "refresh_token").length, 1)
  assert.equal(ctx.apiCalls.length, 10)
  assert.ok(ctx.apiCalls.every((c) => new Headers(c.init.headers).get("authorization") === "Bearer at_2"))
})

test("a token that expires mid-call: a 401 triggers ONE refresh and ONE retry, even for a write", async () => {
  const ctx = setup({
    token: (form) => json(form.get("grant_type") === "refresh_token" ? { access_token: "at_new", refresh_token: "rt_2", expires_in: 3600 } : { access_token: "at_old", refresh_token: "rt_1", expires_in: 3600 }),
    api: (token) => (token === "at_new" ? json({ id: "9" }, 201) : json({ message: "Bad credentials" }, 401)),
  })
  await connectUser(ctx)
  assert.deepEqual(await ctx.conn.execute("items.create", { title: "t" }), { id: "9" })
  assert.equal(ctx.apiCalls.length, 2)
  assert.equal(ctx.tokenCalls.filter((c) => c.form.get("grant_type") === "refresh_token").length, 1)
})

test("a 401 that persists after a refresh gives up (auth_expired), without looping", async () => {
  const ctx = setup({
    token: (form) => json(form.get("grant_type") === "refresh_token" ? { access_token: "at_new", refresh_token: "rt_2", expires_in: 3600 } : { access_token: "at_old", refresh_token: "rt_1", expires_in: 3600 }),
    api: () => json({}, 401),
  })
  await connectUser(ctx)
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("auth_expired"))
  assert.equal(ctx.apiCalls.length, 2)
  assert.equal(ctx.tokenCalls.filter((c) => c.form.get("grant_type") === "refresh_token").length, 1)
})

test("several callers hit the same 401 together: one refresh, all succeed", async () => {
  const ctx = setup({
    token: async (form) => {
      if (form.get("grant_type") !== "refresh_token") return json({ access_token: "at_old", refresh_token: "rt_1", expires_in: 3600 })
      await tick()
      return json({ access_token: "at_new", refresh_token: "rt_2", expires_in: 3600 })
    },
    api: (token) => (token === "at_new" ? json({ id: "1" }) : json({}, 401)),
  })
  await connectUser(ctx)
  await Promise.all(Array.from({ length: 6 }, () => ctx.conn.execute("items.get", { id: "1" })))
  assert.equal(ctx.tokenCalls.filter((c) => c.form.get("grant_type") === "refresh_token").length, 1)
})

test("a revoked refresh token (invalid_grant) means reconnect: auth_expired, record deleted, then not_connected", async () => {
  const ctx = setup({ token: (form) => (form.get("grant_type") === "refresh_token" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 })) })
  await connectUser(ctx)
  ctx.clock.now += 3_600_001
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("auth_expired", (e) => e.message.includes("connect again")))
  assert.equal(await ctx.store.get("cred/acme/user_1"), undefined)
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("not_connected"))
  assert.equal(ctx.apiCalls.length, 0)
})

test("a TRANSIENT refresh failure keeps the connection (we must not log users out over a provider blip)", async () => {
  const ctx = setup({ token: (form) => (form.get("grant_type") === "refresh_token" ? json({}, 503) : json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 })) })
  await connectUser(ctx)
  ctx.clock.now += 3_600_001
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("upstream_error", (e) => e.retryable))
  assert.ok(await ctx.store.get("cred/acme/user_1"))
})

test("expired with no refresh token: auth_expired. A token with no expiry is used indefinitely.", async () => {
  const noRefresh = setup({ token: () => json({ access_token: "at_1", expires_in: 3600 }) })
  await connectUser(noRefresh)
  noRefresh.clock.now += 3_600_001
  await assert.rejects(() => noRefresh.conn.execute("items.get", { id: "1" }), kitError("auth_expired"))

  const forever = setup({ token: () => json({ access_token: "gho_forever" }) }) // like a GitHub OAuth App token
  await connectUser(forever)
  forever.clock.now += 365 * 24 * 3600 * 1000
  await forever.conn.execute("items.get", { id: "1" })
  assert.equal(new Headers(forever.apiCalls[0]!.init.headers).get("authorization"), "Bearer gho_forever")
})

test("static credentials still work on an OAuth connector, and a 401 does not try to refresh", async () => {
  const ctx = setup({ api: () => json({}, 401) })
  const pat = ctx.kit.connect(acme, { connectionId: "u", credentials: { token: "pat_123" } })
  await assert.rejects(() => pat.execute("items.get", { id: "1" }), kitError("auth_expired"))
  assert.equal(ctx.apiCalls.length, 1)
  assert.equal(ctx.tokenCalls.length, 0)
})

test("connections are isolated: one user's token is never used for another", async () => {
  const ctx = setup({ token: (form) => json({ access_token: `at_for_${form.get("code")}`, expires_in: 3600 }) })
  for (const user of ["alice", "bob"]) {
    const { state } = await ctx.kit.startAuth(acme, { connectionId: user })
    await ctx.kit.finishAuth(acme, { code: user, state })
  }
  await ctx.kit.connect(acme, { connectionId: "alice" }).execute("items.get", { id: "1" })
  await ctx.kit.connect(acme, { connectionId: "bob" }).execute("items.get", { id: "1" })
  await assert.rejects(() => ctx.kit.connect(acme, { connectionId: "carol" }).execute("items.get", { id: "1" }), kitError("not_connected"))
  assert.deepEqual(ctx.apiCalls.map((c) => new Headers(c.init.headers).get("authorization")), ["Bearer at_for_alice", "Bearer at_for_bob"])
})

test("a connectionId cannot forge another connection's storage key", async () => {
  const ctx = setup({ token: () => json({ access_token: "at_alice" }) })
  const { state } = await ctx.kit.startAuth(acme, { connectionId: "alice" })
  await ctx.kit.finishAuth(acme, { code: "c", state })
  await assert.rejects(() => ctx.kit.connect(acme, { connectionId: "../acme/alice" }).execute("items.get", { id: "1" }), kitError("not_connected"))
})

test("disconnect forgets the tokens", async () => {
  const ctx = setup({ token: () => json({ access_token: "at_1" }) })
  await connectUser(ctx)
  await ctx.conn.execute("items.get", { id: "1" })
  await ctx.kit.disconnect(acme, { connectionId: "user_1" })
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("not_connected"))
})

test("corrupted stored credentials are a storage_error, not a crash", async () => {
  const ctx = setup()
  await ctx.store.set("cred/acme/user_1", "{not json")
  await assert.rejects(() => ctx.conn.execute("items.get", { id: "1" }), kitError("storage_error"))
})

test("no token, refresh token or client secret ever appears in an error or a tool result", async () => {
  const ctx = setup({
    token: (form) => json(form.get("grant_type") === "refresh_token" ? { error: "invalid_grant", error_description: "rt_1 client_SECRET_456" } : { access_token: "at_1_SECRET", refresh_token: "rt_1_SECRET", expires_in: 3600 }),
    api: () => json({ message: "echoing Bearer at_1_SECRET" }, 500),
  })
  await connectUser(ctx)
  const tools = ctx.kit.toTools(ctx.conn)
  const results = [JSON.stringify(await tools[0]!.run({ id: "1" }))]
  ctx.clock.now += 3_600_001
  results.push(JSON.stringify(await tools[0]!.run({ id: "1" })))
  for (const text of results) {
    for (const secret of ["at_1_SECRET", "rt_1_SECRET", "client_SECRET_456"]) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`)
  }
})

// ============================================================ with encryption at rest

test("end to end through an encrypted store: it works, and the database never holds a token", async () => {
  const inner = memoryTokenStore()
  const store: TokenStore = encryptedStore(inner, createEncryption({ current: "k1", keys: { k1: generateEncryptionKey() } }))
  const ctx = setup({ token: () => json({ access_token: "at_PLAINTEXT_1", refresh_token: "rt_PLAINTEXT_1", expires_in: 3600 }) }, { tokenStore: store })
  await connectUser(ctx)
  await ctx.conn.execute("items.get", { id: "1" })
  assert.equal(new Headers(ctx.apiCalls[0]!.init.headers).get("authorization"), "Bearer at_PLAINTEXT_1")
  const raw = (await inner.get("cred/acme/user_1"))!
  assert.ok(!raw.includes("PLAINTEXT") && raw.startsWith("ck1."))
})
