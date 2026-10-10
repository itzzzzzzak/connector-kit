#!/usr/bin/env node
import { readdirSync } from "node:fs"
import type { ActionDefinition, ConnectorDefinition } from "../define.js"
import { createConnectorKit } from "../kit.js"
import { serveMcp } from "../mcp.js"
import { mcpPolicy, parseMcpArgs, USAGE } from "./args.js"

type AnyConnector = ConnectorDefinition<Record<string, ActionDefinition>>

// Connectors are discovered from the folder, so adding one never means editing this file.
const available = readdirSync(new URL("../connectors/", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
const load = async (name: string) => ((await import(new URL(`../connectors/${name}/index.js`, import.meta.url).href)) as { default: AnyConnector }).default

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
else if (args.list) {
  for (const name of available) {
    const c = await load(name)
    console.error(`${name.padEnd(16)} ${(c.meta?.credentialEnv ?? "?").padEnd(24)} ${c.meta?.status ?? ""}`)
  }
} else {
  const name = args.connector!
  // Only names that exist as folders are ever imported (never a path built from raw input).
  if (!/^[a-z0-9-]+$/.test(name) || !available.includes(name)) fail(`Unknown connector "${name}". Run with --list to see the ${available.length} available.`)
  const connector = await load(name)
  const env = connector.meta?.credentialEnv
  if (!env) fail(`Connector "${name}" declares no credentialEnv.`)
  const token = process.env[env!]
  if (!token) fail(`Set ${env} in the environment (the server config's "env" block).`)
  else {
    // Safe by default: only reads run unless writes are opted into.
    const kit = createConnectorKit({ beforeExecute: mcpPolicy(args.allowWrites) })
    const connection = kit.connect(connector, { connectionId: "mcp", credentials: { token } })
    const tools = kit.toTools(connection, args.only ? { only: args.only } : {})
    console.error(`connector-kit-mcp: serving ${name} (${tools.length} tools, ${args.allowWrites ? "writes allowed" : "read-only"})`)
    await serveMcp(tools, { name: `connector-kit-${name}`, onError: (e) => console.error("connector-kit-mcp: internal error:", e instanceof Error ? e.message : "unknown") })
  }
}
