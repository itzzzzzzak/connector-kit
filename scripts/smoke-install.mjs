// Packs the library exactly like a release does, installs the tarball into an empty project,
// and checks that a stranger could use it. Run: `pnpm smoke` (also runs in CI on every PR).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" })

const work = mkdtempSync(join(tmpdir(), "connector-kit-smoke-"))
run("npm", ["pack", "--pack-destination", work], process.cwd())
const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"))
if (!tarball) throw new Error("npm pack produced no tarball")

const app = join(work, "app")
mkdirSync(app)
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }))
run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], app)

writeFileSync(
  join(app, "check.mjs"),
  `
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { createConnectorKit, defineConnector, ConnectorKitError } from "connector-kit"
import { github } from "connector-kit/github"

assert.equal(typeof createConnectorKit, "function")
assert.equal(typeof defineConnector, "function")
assert.equal(typeof ConnectorKitError, "function")
assert.deepEqual(Object.keys(github.actions).sort(), ["issues.list", "repos.get"])

const kit = createConnectorKit({ fetch: async () => new Response("{}", { status: 200 }) })
const tools = kit.toTools(kit.connect(github, { connectionId: "smoke", credentials: { token: "x" } }))
assert.deepEqual(tools.map((t) => t.name).sort(), ["github_issues_list", "github_repos_get"])

const shipped = readdirSync("node_modules/connector-kit/dist", { recursive: true }).map(String)
assert.ok(!shipped.some((f) => /\\.test\\.|\\.map$/.test(f)), "tests or source maps leaked into the package")
console.log("smoke ok: installed from tarball, imports work, tools generate, no test files shipped")
`,
)
run("node", ["check.mjs"], app)
