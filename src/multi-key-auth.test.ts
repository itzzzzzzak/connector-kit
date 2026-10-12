import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { checkConnector, createConnectorKit, defineConnector } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const dd = defineConnector({
  name: "pair",
  baseUrl: "https://api.pair.test",
  auth: { type: "apiKeys", headers: ["DD-API-KEY", "DD-APPLICATION-KEY"] },
  actions: { "things.list": { description: "List things for the connector auth test.", method: "GET", path: "/things", input: z.object({}), output: z.unknown(), effect: "read" } },
})

test("apiKeys: each value goes in its own header, in order", async () => {
  const { conn, calls } = harness(dd, () => json({}), { credentials: { token: "apikey123:appkey456" } })
  await conn.execute("things.list", {})
  assert.equal(calls[0]!.header("dd-api-key"), "apikey123")
  assert.equal(calls[0]!.header("dd-application-key"), "appkey456")
  assert.equal(calls[0]!.header("authorization"), null)
})

test("apiKeys: a credential with the wrong number of values is refused when connecting", () => {
  const kit = createConnectorKit({ fetch: (async () => json({})) as typeof fetch })
  for (const token of ["onlyone", "a:b:c", ""]) assert.throws(() => kit.connect(dd, { connectionId: "x", credentials: { token } }), /needs 2 keys/, token)
})

test("apiKeys: the conformance check wants two or more distinct, valid header names", () => {
  const bad = (headers: string[]) => checkConnector({ ...dd, auth: { type: "apiKeys", headers } }, { requireMeta: false })
  assert.deepEqual(bad(["A-Key", "B-Key"]), [])
  assert.match(bad(["A-Key"]).join(), /at least two/)
  assert.match(bad(["A-Key", "a-key"]).join(), /different/)
  assert.match(bad(["A-Key", "B Key"]).join(), /not a valid header/)
})
