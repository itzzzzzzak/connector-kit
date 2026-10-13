import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { checkConnector, defineConnector } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const bot = defineConnector({
  name: "pathbot",
  baseUrl: "https://api.pathbot.test",
  auth: { type: "pathToken", prefix: "bot" },
  actions: {
    "things.list": { description: "List things for the path token auth test.", method: "GET", path: "/things", input: z.object({ q: z.string().optional() }), output: z.unknown(), effect: "read" },
    "things.add": { description: "Add a thing for the path token auth test.", method: "POST", path: "/things", input: z.object({ name: z.string() }), output: z.unknown(), effect: "write" },
  },
})

test("pathToken: the prefix and token go right after the base, before the action path, and no header carries them", async () => {
  const { conn, calls } = harness(bot, () => json({}), { credentials: { token: "123456:AA-bb_CC" } })
  await conn.execute("things.list", { q: "x y" })
  assert.equal(calls[0]!.url.pathname, "/bot123456:AA-bb_CC/things")
  assert.equal(calls[0]!.url.searchParams.get("q"), "x y")
  assert.equal(calls[0]!.header("authorization"), null)
})

test("pathToken: a token cannot add path segments or a query", async () => {
  const { conn, calls } = harness(bot, () => json({}), { credentials: { token: "1/../admin?x=1#y" } })
  await conn.execute("things.add", { name: "n" })
  assert.equal(calls[0]!.url.host, "api.pathbot.test")
  assert.equal(calls[0]!.url.search, "")
  assert.ok(calls[0]!.url.pathname.endsWith("/things"))
  assert.ok(!calls[0]!.url.pathname.includes("/admin"))
})

test("pathToken: the token is not in the error when the provider refuses it", async () => {
  const { conn } = harness(bot, () => json({ description: "Unauthorized" }, 401), { credentials: { token: "999:SECRETSECRET" } })
  await assert.rejects(() => conn.execute("things.list", {}), (e: unknown) => !(JSON.stringify(e) + (e as Error).message).includes("SECRETSECRET"))
})

test("pathToken: the conformance check limits the prefix", () => {
  const withPrefix = (prefix: string) => checkConnector({ ...bot, auth: { type: "pathToken", prefix } }, { requireMeta: false })
  assert.deepEqual(withPrefix("bot"), [])
  assert.deepEqual(withPrefix(""), [])
  assert.match(withPrefix("../x").join(), /prefix/)
})
