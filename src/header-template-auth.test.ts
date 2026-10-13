import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { checkConnector, defineConnector } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const tpl = 'OAuth key="{1}", token="{2}"'
const svc = defineConnector({
  name: "tplsvc",
  baseUrl: "https://api.tplsvc.test",
  auth: { type: "headerTemplate", header: "Authorization", template: tpl },
  actions: {
    "things.list": { description: "List things for the header template auth test.", method: "GET", path: "/things", input: z.object({}), output: z.unknown(), effect: "read" },
  },
})

test("headerTemplate: the credential values fill the numbered slots of one header", async () => {
  const { conn, calls } = harness(svc, () => json({}), { credentials: { token: "KEY123:TOKEN456" } })
  await conn.execute("things.list", {})
  assert.equal(calls[0]!.header("authorization"), 'OAuth key="KEY123", token="TOKEN456"')
  assert.equal(calls[0]!.url.search, "")
})

test("headerTemplate: a credential with the wrong number of values is refused", async () => {
  for (const token of ["ONLYONE", "A:B:C"]) {
    const calls: unknown[] = []
    await assert.rejects(async () => {
      const h = harness(svc, () => json({}), { credentials: { token } })
      await h.conn.execute("things.list", {})
    })
    assert.equal(calls.length, 0)
  }
})

test("headerTemplate: a value cannot break out of the header", async () => {
  for (const token of ['A":B', "A:B\r\nX-Evil: 1", "A: B"]) {
    let sent = 0
    await assert.rejects(async () => {
      const h = harness(svc, () => { sent++; return json({}) }, { credentials: { token } })
      await h.conn.execute("things.list", {})
    })
    assert.equal(sent, 0)
  }
})

test("headerTemplate: the secret is not in the error when the provider refuses it", async () => {
  const { conn } = harness(svc, () => json({ message: "no" }, 401), { credentials: { token: "KEYAAA:SECRETSECRET" } })
  await assert.rejects(() => conn.execute("things.list", {}), (e: unknown) => !(JSON.stringify(e) + (e as Error).message).includes("SECRETSECRET"))
})

test("headerTemplate: the conformance check validates the header name and the slots", () => {
  const withAuth = (header: string, template: string) => checkConnector({ ...svc, auth: { type: "headerTemplate", header, template } }, { requireMeta: false })
  assert.deepEqual(withAuth("Authorization", tpl), [])
  assert.notDeepEqual(withAuth("Bad Header", tpl), [])
  assert.notDeepEqual(withAuth("Authorization", "no slots"), [])
  assert.notDeepEqual(withAuth("Authorization", "{1} {3}"), [])
  assert.notDeepEqual(withAuth("Authorization", "{1}\r\n{2}"), [])
})
