#!/usr/bin/env node
import type { ActionDefinition, ConnectorDefinition } from "../define.js"
import { createConnectorKit } from "../kit.js"
import { github } from "../connectors/github/index.js"
import { serveMcp } from "../mcp.js"
import { mcpPolicy, parseMcpArgs, USAGE } from "./args.js"

const REGISTRY: Record<string, { connector: ConnectorDefinition<Record<string, ActionDefinition>>; tokenEnv: string }> = {
  github: { connector: github, tokenEnv: "GITHUB_TOKEN" },
}

// stdout is the protocol channel: everything human-readable goes to stderr.
const fail = (message: string): never => {
  console.error(`connector-kit-mcp: ${message}`)
  process.exit(2)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error(USAGE)
  process.exit(0)
}

const args = parseMcpArgs(process.argv.slice(2))
if ("error" in args) fail(`${args.error}\n\n${USAGE}`)
else {
  const entry = REGISTRY[args.connector]
  if (!entry) fail(`Unknown connector "${args.connector}". Available: ${Object.keys(REGISTRY).join(", ")}`)
  else {
    const token = process.env[entry.tokenEnv]
    if (!token) fail(`Set ${entry.tokenEnv} in the environment (the server config's "env" block).`)
    else {
      // Safe by default: only reads run unless writes are opted into.
      const kit = createConnectorKit({ beforeExecute: mcpPolicy(args.allowWrites) })
      const connection = kit.connect(entry.connector, { connectionId: "mcp", credentials: { token } })
      const tools = kit.toTools(connection, args.only ? { only: args.only } : {})
      console.error(`connector-kit-mcp: serving ${args.connector} (${tools.length} tools, ${args.allowWrites ? "writes allowed" : "read-only"})`)
      await serveMcp(tools, { name: `connector-kit-${args.connector}`, onError: (e) => console.error("connector-kit-mcp: internal error:", e instanceof Error ? e.message : "unknown") })
    }
  }
}
