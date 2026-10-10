import type { BeforeExecute } from "../policy.js"

export interface McpCliArgs {
  connector: string
  only?: string[]
  allowWrites: boolean
}

export const USAGE = `Usage: connector-kit-mcp <connector> [--only action1,action2] [--allow-writes]

Serves a connector's actions as MCP tools over stdio.

  <connector>       one of: github, slack
  --only a,b        expose only these actions (e.g. repos.get,issues.list)
  --allow-writes    allow actions that change data. Default is read-only.
                    Destructive actions are never allowed through this command.

Credentials come from the environment (github: GITHUB_TOKEN, slack: SLACK_BOT_TOKEN).`

/** Returns the parsed args, or an error message to show the user. */
export function parseMcpArgs(argv: string[]): McpCliArgs | { error: string } {
  let connector: string | undefined
  let only: string[] | undefined
  let allowWrites = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--allow-writes") allowWrites = true
    else if (arg === "--only") {
      const value = argv[++i]
      if (!value) return { error: "--only needs a comma-separated list of actions" }
      only = value.split(",").map((s) => s.trim()).filter(Boolean)
    } else if (arg.startsWith("-")) return { error: `Unknown option: ${arg}` }
    else if (connector === undefined) connector = arg
    else return { error: `Unexpected argument: ${arg}` }
  }
  if (connector === undefined) return { error: "Missing connector name" }
  return { connector, ...(only && { only }), allowWrites }
}

/**
 * The CLI's policy. This process is driven by a model, so it is read-only unless writes are
 * explicitly allowed, and destructive actions are never allowed through it.
 */
export function mcpPolicy(allowWrites: boolean): BeforeExecute {
  return ({ effect }) => {
    if (effect === "read") return { allow: true }
    if (effect === "write" && allowWrites) return { allow: true }
    return {
      allow: false,
      reason: effect === "write" ? "this server is read-only (start it with --allow-writes to permit writes)" : "destructive actions are not permitted through this server",
    }
  }
}
