// End-to-end over REAL HTTP: a local server plays the OAuth provider and the API, and the kit uses the
// real global fetch. Mocks cannot prove form encoding, headers or status handling; this does.
import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, test } from "node:test"
import { z } from "zod"
import { createEncryption, encryptedStore, generateEncryptionKey } from "./crypto.js"
import { createConnectorKit, defineConnector, memoryTokenStore } from "./index.js"

const body = (req: IncomingMessage) => new Promise<string>((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)) })

let origin = ""
const issued = { codes: new Set<string>(), access: new Set<string>(), refresh: new Set<string>() }
const log: string[] = []
let counter = 0

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x")
  const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)) }
  if (url.pathname === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await body(req))
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded")
    if (form.get("grant_type") === "authorization_code") {
      log.push("exchange")
      if (!issued.codes.delete(form.get("code") ?? "")) return send(400, { error: "invalid_grant" })
      const access = `at_${++counter}`, refresh = `rt_${counter}`
      issued.access.add(access); issued.refresh.add(refresh)
      return send(200, { access_token: access, refresh_token: refresh, expires_in: 3600, scope: "read" })
    }
    if (form.get("grant_type") === "refresh_token") {
      log.push("refresh")
      if (!issued.refresh.delete(form.get("refresh_token") ?? "")) return send(400, { error: "invalid_grant" }) // rotating: each refresh token works once
      const access = `at_${++counter}`, refresh = `rt_${counter}`
      issued.access.add(access); issued.refresh.add(refresh)
      return send(200, { access_token: access, refresh_token: refresh, expires_in: 3600 })
    }
    return send(400, { error: "unsupported_grant_type" })
  }
  if (url.pathname.startsWith("/api/items/")) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    if (!issued.access.has(token)) return send(401, { message: "Bad credentials" })
    return send(200, { id: url.pathname.split("/").pop(), seenToken: token })
  }
  send(404, {})
})

before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve() })))
after(() => new Promise<void>((resolve) => server.close(() => resolve())))

const provider = () =>
  defineConnector({
    name: "local",
    baseUrl: `${origin}/api`,
    auth: { type: "oauth2", authorizeUrl: `${origin}/authorize`, tokenUrl: `${origin}/token` },
    actions: { "items.get": { description: "Get an item.", method: "GET", path: "/items/{id}", input: z.object({ id: z.string() }), output: z.object({ id: z.string(), seenToken: z.string() }), effect: "read" } },
  })

test("the whole journey over real HTTP: connect, call, token expires, silent rotating refresh, call again", async () => {
  const local = provider()
  const clock = { now: Date.now() }
  const inner = memoryTokenStore({ now: () => clock.now })
  const kit = createConnectorKit({
    tokenStore: encryptedStore(inner, createEncryption({ current: "k1", keys: { k1: generateEncryptionKey() } })),
    oauth: { local: { clientId: "cid", clientSecret: "csecret", redirectUri: "https://app.test/cb" } },
    now: () => clock.now,
  })

  // 1. the host sends the user to the provider; the provider redirects back with a code
  const { url, state } = await kit.startAuth(local, { connectionId: "user_7" })
  assert.equal(new URL(url).searchParams.get("state"), state)
  issued.codes.add("code_from_provider")
  const connected = await kit.finishAuth(local, { code: "code_from_provider", state, expectedConnectionId: "user_7" })
  assert.deepEqual(connected, { connectionId: "user_7", scope: "read" })

  // 2. use it
  const conn = kit.connect(local, { connectionId: "user_7" })
  const first = await conn.execute("items.get", { id: "1" })
  assert.equal(first.seenToken, "at_1")

  // 3. the token expires: the next call refreshes silently, and the rotated refresh token is saved
  clock.now += 3_600_001
  const second = await conn.execute("items.get", { id: "1" })
  assert.equal(second.seenToken, "at_2")
  clock.now += 3_600_001
  assert.equal((await conn.execute("items.get", { id: "1" })).seenToken, "at_3") // would fail if the rotated refresh token had not been saved

  // 4. concurrency against a provider that invalidates a refresh token on first use
  clock.now += 3_600_001
  const results = await Promise.all(Array.from({ length: 8 }, () => conn.execute("items.get", { id: "1" })))
  assert.ok(results.every((r) => r.seenToken === "at_4"))
  assert.equal(log.filter((l) => l === "refresh").length, 3, "one refresh per expiry, not one per caller")

  // 5. what the database holds is ciphertext
  const raw = (await inner.get("cred/local/user_7"))!
  assert.ok(raw.startsWith("ck1.") && !raw.includes("at_4") && !raw.includes("rt_"))
})

test("a rejected code over real HTTP is a clean invalid_input", async () => {
  const local = provider()
  const kit = createConnectorKit({ tokenStore: memoryTokenStore(), oauth: { local: { clientId: "cid", redirectUri: "https://app.test/cb" } } })
  const { state } = await kit.startAuth(local, { connectionId: "u" })
  await assert.rejects(() => kit.finishAuth(local, { code: "never_issued", state }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("a token the provider revoked behind our back: 401, refresh rejected, user must reconnect", async () => {
  const local = provider()
  const kit = createConnectorKit({ tokenStore: memoryTokenStore(), oauth: { local: { clientId: "cid", clientSecret: "s", redirectUri: "https://app.test/cb" } }, retry: { maxRetries: 0 } })
  const { state } = await kit.startAuth(local, { connectionId: "u" })
  issued.codes.add("c2")
  await kit.finishAuth(local, { code: "c2", state })
  issued.access.clear() // the provider revokes everything
  issued.refresh.clear()
  const conn = kit.connect(local, { connectionId: "u" })
  await assert.rejects(() => conn.execute("items.get", { id: "1" }), (e: unknown) => (e as { code?: string }).code === "auth_expired")
  await assert.rejects(() => conn.execute("items.get", { id: "1" }), (e: unknown) => (e as { code?: string }).code === "not_connected")
})
