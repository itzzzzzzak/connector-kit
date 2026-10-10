// Keeps package.json "exports" in step with src/connectors/*: one subpath per connector folder.
//   node scripts/sync-exports.mjs          rewrite package.json
//   node scripts/sync-exports.mjs --check  fail if it is out of date (CI)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

const check = process.argv.includes("--check")
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const names = readdirSync("src/connectors", { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`src/connectors/${d.name}/index.ts`))
  .map((d) => d.name)
  .sort()

const exports = { ".": pkg.exports["."] }
for (const name of names) exports[`./${name}`] = { types: `./dist/connectors/${name}/index.d.ts`, default: `./dist/connectors/${name}/index.js` }
exports["./mcp"] = pkg.exports["./mcp"]
exports["./package.json"] = "./package.json"

if (JSON.stringify(pkg.exports) === JSON.stringify(exports)) {
  console.log(`exports up to date (${names.length} connectors)`)
} else if (check) {
  const have = new Set(Object.keys(pkg.exports))
  const want = new Set(Object.keys(exports))
  console.error("package.json exports are out of date. Run `pnpm sync`.")
  for (const key of want) if (!have.has(key)) console.error(`  missing: ${key}`)
  for (const key of have) if (!want.has(key)) console.error(`  stale:   ${key}`)
  process.exit(1)
} else {
  pkg.exports = exports
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
  console.log(`updated exports (${names.length} connectors)`)
}
