// Opt-in smoke test against the REAL Figma API. Skipped unless FIGMA_TOKEN is set. Read-only actions only.
// Passing this (and your sign-off in a PR) is what lets the connector move from "docs-based" to "live-tested".
//   FIGMA_TOKEN=... pnpm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { createConnectorKit } from "../../index.js"
import figma from "./index.js"

const token = process.env.FIGMA_TOKEN
const skip = token ? false : "set FIGMA_TOKEN to run live tests"
const conn = () => createConnectorKit().connect(figma, { connectionId: "live", credentials: { token: token! } })

// FIGMA_FILE_KEY (optional): a file the token can read, to also check files and comments.
test("live: me, and a file's structure and comments", { skip }, async () => {
  const me = await conn().execute("me.get", {})
  assert.ok(me.id)
  const key = process.env.FIGMA_FILE_KEY
  if (!key) return
  const file = await conn().execute("files.get", { file_key: key, depth: 1 })
  assert.ok(file.name.length > 0)
  await conn().execute("comments.list", { file_key: key })
})
