// Packs the library exactly like a release does, installs the tarball into an empty project,
// and runs scripts/smoke-check.mjs there, so a stranger's experience is tested, not just our unit tests.
// Run: `pnpm smoke` (also runs in CI on every PR and before a release tarball is attached).
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
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

copyFileSync(join(process.cwd(), "scripts", "smoke-check.mjs"), join(app, "check.mjs"))
run("node", ["check.mjs"], app)
