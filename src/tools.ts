import { z } from "zod"
import type { ActionDefinition } from "./define.js"
import { ConnectorKitError, type ErrorCode } from "./errors.js"
import type { Connection } from "./kit.js"

/** What a model gets back. Never contains credentials or raw provider bodies. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean; retryAfter?: number } }

/** A connector action in the shape LLM tool-calling APIs expect. */
export interface Tool {
  /** e.g. "github_issues_list": LLM APIs generally allow only letters, digits, "_" and "-". */
  name: string
  description: string
  /** JSON Schema for the input (generated from the action's Zod schema). */
  inputSchema: Record<string, unknown>
  effect: ActionDefinition["effect"]
  /** Runs the action. API failures come back as `{ ok: false }` so a model can read and react to them. */
  run(input: unknown): Promise<ToolResult>
}

export interface ToolsOptions {
  /** Expose only these actions (e.g. ["issues.list"]). Fewer tools means less model context. */
  only?: string[]
}

const toolName = (connector: string, action: string) => `${connector}_${action}`.replace(/[^A-Za-z0-9_-]/g, "_")

export function toTools<A extends Record<string, ActionDefinition>>(connection: Connection<A>, options: ToolsOptions = {}): Tool[] {
  const { connector } = connection
  const names = options.only ?? Object.keys(connector.actions)
  const seen = new Set<string>()

  return names.map((action) => {
    const definition = connector.actions[action]
    if (!definition) throw new Error(`toTools: connector "${connector.name}" has no action "${action}".`)
    const name = toolName(connector.name, action)
    if (seen.has(name)) throw new Error(`toTools: two actions map to the tool name "${name}".`)
    seen.add(name)

    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(definition.input, { io: "input" }) as Record<string, unknown>
    return {
      name,
      description: definition.description,
      inputSchema,
      effect: definition.effect,
      async run(input: unknown): Promise<ToolResult> {
        try {
          return { ok: true, data: await connection.execute(action as keyof A & string, input as never) }
        } catch (error) {
          // Programmer errors should surface to the developer, not be shown to a model.
          if (!(error instanceof ConnectorKitError)) throw error
          return {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.retryAfter !== undefined && { retryAfter: error.retryAfter }),
            },
          }
        }
      },
    }
  })
}
