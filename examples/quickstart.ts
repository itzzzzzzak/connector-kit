// Run:  pnpm build && GITHUB_TOKEN=... pnpm example:quickstart
import { createConnectorKit } from "connector-kit"
import { github } from "connector-kit/github"

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error("Set GITHUB_TOKEN first (a GitHub personal access token with read access).")
  process.exit(1)
}

const kit = createConnectorKit({
  // Host policy (ADR-007): the kit has none of its own. Here, nothing destructive runs.
  beforeExecute: ({ effect }) => (effect === "destructive" ? { allow: false, reason: "destructive actions are disabled" } : { allow: true }),
})
const gh = kit.connect(github, { connectionId: "me", credentials: { token } })

// 1. As a normal developer SDK: typed in, typed out.
const repo = await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })
console.log(`${repo.full_name}: ${repo.stargazers_count} stars, default branch ${repo.default_branch}`)

const page = await gh.execute("issues.list", { owner: "octocat", name: "Hello-World", pageSize: 3 })
console.log(`first page: ${page.items.length} issues, more pages: ${page.nextCursor !== null}`)
for (const issue of page.items) console.log(`  #${issue.number} ${issue.title}`)

// 2. As agent tools: this is what you hand to an LLM API.
const tools = kit.toTools(gh)
console.log("\nTools an LLM would see:")
for (const tool of tools) console.log(`  ${tool.name} [${tool.effect}]: ${tool.description}`)

// 3. What happens when a model calls one (here we play the model, with bad and good arguments).
const issuesTool = tools.find((t) => t.name === "github_issues_list")!
console.log("\nbad arguments ->", JSON.stringify(await issuesTool.run({ owner: 123 })))
const good = await issuesTool.run({ owner: "octocat", name: "Hello-World", pageSize: 1 })
console.log("good arguments ->", good.ok ? `${(good.data as { items: unknown[] }).items.length} item(s)` : good.error)
