// Scaffolds a new connector: node scripts/new-connector.mjs <name>   (lowercase, hyphens: "google-sheets")
// The result is deliberately INCOMPLETE (placeholders fail the conformance check) so nothing half-finished ships.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const name = process.argv[2]
if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  console.error("Usage: node scripts/new-connector.mjs <name>   e.g. stripe, google-sheets (lowercase, single hyphens)")
  process.exit(2)
}
const dir = `src/connectors/${name}`
if (existsSync(dir)) {
  console.error(`${dir} already exists.`)
  process.exit(1)
}
const camel = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
const title = name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
const env = name.toUpperCase().replace(/-/g, "_")

mkdirSync(dir, { recursive: true })
writeFileSync(
  `${dir}/index.ts`,
  `import { defineConnector } from "../../index.js"
import { z } from "zod"

// Read docs/writing-connectors.md first. Replace every TODO: the conformance check fails until you do.
export const ${camel} = defineConnector({
  name: "${name}",
  baseUrl: "https://api.TODO.dev/v1",
  auth: { type: "bearer" }, // or apiKey / oauth2: see docs/writing-connectors.md
  meta: {
    title: "${title}",
    description: "TODO: one sentence on what an agent or app can do with it.",
    docsUrl: "https://TODO.dev/docs/api",
    status: "docs-based", // only change to "live-tested" after running it against the real API
    credentialEnv: "${env}_TOKEN",
  },
  actions: {
    "things.get": {
      description: "TODO: say what it returns and WHEN to use it, for a model choosing between tools.",
      method: "GET",
      path: "/things/{id}",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }), // list only the fields you are sure of
      effect: "read",
    },
  },
})

export default ${camel}
`,
)
writeFileSync(
  `${dir}/${name}.test.ts`,
  `import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectorKitError } from "../../index.js"
import { harness, json } from "../../connector-harness.test.js"
import ${camel} from "./index.js"

test("things.get calls the right URL with the token", async () => {
  const { conn, calls } = harness(${camel}, () => json({ id: "1" }))
  assert.deepEqual(await conn.execute("things.get", { id: "1" }), { id: "1" })
  assert.equal(calls[0]!.url.pathname.endsWith("/things/1"), true)
  assert.equal(calls[0]!.header("authorization"), "Bearer test-token")
})

test("a missing thing is not_found", async () => {
  const { conn } = harness(${camel}, () => json({}, 404))
  await assert.rejects(() => conn.execute("things.get", { id: "x" }), (e: unknown) => e instanceof ConnectorKitError && e.code === "not_found")
})

// TODO: for EVERY action also test: a 429 (rate_limited), a malformed response (upstream_error), bad input
// (invalid_input, and that nothing was sent), and for writes that a 5xx is not retried. See docs/writing-connectors.md.
`,
)
execFileSync("node", ["scripts/sync-exports.mjs"], { stdio: "inherit" })
console.log(`\nCreated ${dir}/. Next:\n  1. Fill in index.ts from the provider's OFFICIAL API docs (replace every TODO)\n  2. pnpm test            # the conformance check lists what is still wrong\n  3. pnpm catalog         # regenerate docs/connectors.md\nGuide: docs/writing-connectors.md`)
