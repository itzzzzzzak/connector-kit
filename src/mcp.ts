import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { Tool } from "./tools.js"

/**
 * Minimal MCP server (tools only) over JSON-RPC, built on `Tool[]` from `kit.toTools()`.
 * ADR-013: dependency-free on purpose; it is tested against the official SDK's client.
 */

export interface McpOptions {
  name?: string
  version?: string
  /** Tool results longer than this are cut so one call cannot flood a model's context. Default 100 000. */
  maxResultChars?: number
  /** Called for unexpected internal errors (programmer bugs). Details never go to the client. */
  onError?: (error: unknown) => void
}

type JsonRpcId = string | number | null
export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const failure = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } })

export function createMcpHandler(tools: Tool[], options: McpOptions = {}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const maxChars = options.maxResultChars ?? 100_000

  const describe = (tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Hints let clients decide what to auto-approve. They come from the connector's `effect` label.
    annotations: {
      readOnlyHint: tool.effect === "read",
      destructiveHint: tool.effect === "destructive",
      openWorldHint: true,
    },
  })

  async function callTool(params: unknown) {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown }
    const tool = typeof name === "string" ? byName.get(name) : undefined
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`)

    const result = await tool.run(args ?? {})
    let text = JSON.stringify(result.ok ? (result.data ?? null) : result.error)
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters; request a smaller pageSize or narrower input]`
    }
    return { content: [{ type: "text", text }], isError: !result.ok }
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        return {
          protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: options.name ?? "connector-kit", version: options.version ?? "0.0.0" },
        }
      }
      case "ping":
        return {}
      case "tools/list":
        return { tools: tools.map(describe) }
      case "tools/call":
        return callTool(params)
      default:
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  return {
    /** Handle one decoded JSON-RPC message. Returns the response, or undefined for notifications. */
    async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return failure(null, -32600, "Invalid Request")
      const { id, method, params } = message as { id?: JsonRpcId; method?: unknown; params?: unknown }
      if (typeof method !== "string") return undefined // a response from the client, or junk: nothing to answer

      if (id === undefined) {
        // Notification (e.g. notifications/initialized): never answered, even on error.
        try {
          if (!method.startsWith("notifications/")) await dispatch(method, params)
        } catch (error) {
          if (!(error instanceof RpcError)) options.onError?.(error)
        }
        return undefined
      }

      try {
        return { jsonrpc: "2.0", id, result: await dispatch(method, params) }
      } catch (error) {
        if (error instanceof RpcError) return failure(id, error.code, error.message)
        options.onError?.(error)
        return failure(id, -32603, "Internal error")
      }
    },
  }
}

export interface ServeOptions extends McpOptions {
  input?: Readable
  output?: Writable
}

/**
 * Serve over stdio: newline-delimited JSON-RPC. stdout carries ONLY protocol messages
 * (anything else corrupts the stream), so diagnostics must go to stderr.
 */
export function serveMcp(tools: Tool[], options: ServeOptions = {}): Promise<void> {
  const handler = createMcpHandler(tools, options)
  const output = options.output ?? process.stdout
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity })
  const inflight = new Set<Promise<void>>()
  const send = (response: JsonRpcResponse) => void output.write(`${JSON.stringify(response)}\n`)

  lines.on("line", (line) => {
    if (line.trim() === "") return
    const task = (async () => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        send(failure(null, -32700, "Parse error"))
        return
      }
      const response = await handler.handle(message)
      if (response) send(response)
    })()
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
  })

  return new Promise((resolve) => {
    lines.on("close", () => void Promise.allSettled([...inflight]).then(() => resolve()))
  })
}
