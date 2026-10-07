# ADR-013: A dependency-free MCP server, read-only by default

- Status: accepted
- Date: 2026-10-08

## Problem
MCP hosts (Claude Desktop, Claude Code, Cursor, ...) should be able to use any connector as tools with no code. How should the server be built, and what may a model-driven process be allowed to do?

## Alternatives considered
- Depend on the official `@modelcontextprotocol/sdk` in the library (heavy transitive dependencies for every user, and a Zod-version coupling).
- A tiny hand-written server, verified against the official SDK's client in tests.

## Decision
- `connector-kit/mcp` implements the tools part of MCP (initialize, ping, tools/list, tools/call) as a pure message handler plus a newline-delimited JSON-RPC stdio runner. No new runtime dependency. The official SDK is a **dev** dependency used only so a real MCP client drives our compiled CLI in tests.
- MCP is its own subpath, not re-exported from the package root, because it imports Node-only modules and the core must stay usable on other runtimes.
- Tool `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) are derived from each action's `effect`.
- API failures are tool results with `isError: true` (a model can read and react); protocol problems are JSON-RPC errors; unexpected internal failures return a generic error and are logged to stderr, never detailed to the client.
- stdout carries only protocol messages; diagnostics go to stderr.
- Results over 100 000 characters are truncated with a hint, so one call cannot flood a model's context.
- The `connector-kit-mcp` command is **read-only by default**: `--allow-writes` permits writes, destructive actions are never allowed through it. Hosts that need more embed `serveMcp` with their own `beforeExecute`.

## Why
Zero-code access from any MCP host is the fastest way for people to try and use the library, and the defaults assume the caller is a model.

## Trade-offs
We maintain a small protocol implementation (tools only; no resources, prompts, sampling, auth, or HTTP transport). A new protocol revision may need an update; the conformance test against the official client is the safety net.

## When we may revisit
When remote (Streamable HTTP) transport or MCP authorization is needed, or if the protocol surface we use grows enough that depending on the SDK is cheaper.
