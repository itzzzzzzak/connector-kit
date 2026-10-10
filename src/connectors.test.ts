// Runs over EVERY directory in src/connectors, so a new connector is checked the moment it is added:
// well-formed, named after its folder, exported from package.json, and accompanied by its own tests.
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { checkConnector, type ActionDefinition, type ConnectorDefinition } from "./index.js"

const dir = new URL("./connectors/", import.meta.url)
const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> }

test("the connector directory is not empty", () => {
  assert.ok(names.length >= 2, `found: ${names.join(", ")}`)
})

for (const name of names) {
  test(`connector "${name}": conformance, naming, export and tests`, async () => {
    const mod = (await import(new URL(`./connectors/${name}/index.js`, import.meta.url).href)) as { default?: ConnectorDefinition<Record<string, ActionDefinition>> }
    const connector = mod.default
    assert.ok(connector, `src/connectors/${name}/index.ts must have a default export (the connector)`)
    assert.equal(connector.name, name, "the connector's name must equal its folder name")

    assert.deepEqual(checkConnector(connector), [], `connector "${name}" has quality problems`)

    const files = readdirSync(new URL(`./connectors/${name}/`, import.meta.url))
    assert.ok(files.some((f) => f.endsWith(".test.js") && !f.startsWith("live")), `connector "${name}" needs its own tests (a *.test.ts next to index.ts)`)

    assert.deepEqual(pkg.exports[`./${name}`], { types: `./dist/connectors/${name}/index.d.ts`, default: `./dist/connectors/${name}/index.js` }, `package.json is missing the "./${name}" export: run pnpm sync`)
    assert.ok(existsSync(new URL(`./connectors/${name}/index.js`, import.meta.url)))
  })
}
