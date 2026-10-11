import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { defineConnector } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const basic = defineConnector({
  name: "basicco",
  baseUrl: "https://api.basicco.dev/v1",
  auth: { type: "basic" },
  actions: { "me.get": { description: "Get the authenticated account. Use to check the credentials.", method: "GET", path: "/me", input: z.object({}), output: z.object({ id: z.string() }), effect: "read" } },
})
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

test("a 'username:password' token is sent as HTTP Basic", async () => {
  const { conn, calls } = harness(basic, () => json({ id: "1" }), { credentials: { token: "me@x.dev:s3cret" } })
  await conn.execute("me.get", {})
  assert.equal(calls[0]!.header("authorization"), `Basic ${b64("me@x.dev:s3cret")}`)
})

test("{ username, password } credentials give the same header", async () => {
  const { conn, calls } = harness(basic, () => json({ id: "1" }), { credentials: { username: "AC123", password: "tok" } as never })
  await conn.execute("me.get", {})
  assert.equal(calls[0]!.header("authorization"), `Basic ${b64("AC123:tok")}`)
})

test("a password may itself contain colons, and non-ASCII credentials are UTF-8 encoded", async () => {
  const { conn, calls } = harness(basic, () => json({ id: "1" }), { credentials: { username: "zoë", password: "p:a:ss wörd" } as never })
  await conn.execute("me.get", {})
  assert.equal(calls[0]!.header("authorization"), `Basic ${b64("zoë:p:a:ss wörd")}`)
})

test("a token without a colon is rejected at connect time with a message that explains the format", () => {
  assert.throws(() => harness(basic, () => json({}), { credentials: { token: "justatoken" } }), /username:password/)
})

test("neither the secret nor its base64 form ever appears in an error", async () => {
  const { conn } = harness(basic, () => json({ message: "denied" }, 401), { credentials: { token: "me@x.dev:TOPSECRET" } })
  await assert.rejects(() => conn.execute("me.get", {}), (e: unknown) => {
    const text = JSON.stringify(e) + (e as Error).message + JSON.stringify(Object.getOwnPropertyDescriptors(e))
    assert.equal((e as { code?: string }).code, "auth_expired")
    return !text.includes("TOPSECRET") && !text.includes(b64("me@x.dev:TOPSECRET"))
  })
})

test("a 401 is not retried or refreshed (static credentials cannot be renewed)", async () => {
  const { conn, calls } = harness(basic, () => json({}, 401), { credentials: { token: "u:p" }, retry: { maxRetries: 3, sleep: async () => {}, random: () => 0 } })
  await assert.rejects(() => conn.execute("me.get", {}))
  assert.equal(calls.length, 1)
})
