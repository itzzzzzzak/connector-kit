# ADR-011: `toTools()` and the `beforeExecute` policy hook

- Status: accepted
- Date: 2026-10-07

## Problem
An agent needs a connector's actions as tool definitions, and the host needs a place to decide whether a dangerous action may run. The kit must not decide policy for the host (ADR-007) or leak secrets to a model.

## Decision
- `kit.toTools(connection, { only? })` returns `{ name, description, inputSchema, effect, run }[]`. `inputSchema` is JSON Schema generated from the action's Zod input (`io: "input"`). Names are `<connector>_<action>` with non `[A-Za-z0-9_-]` characters replaced by `_` (LLM APIs reject dots); collisions throw.
- `tool.run` never throws for API failures: it returns `{ ok: false, error: { code, message, retryable, retryAfter? } }`. It never includes credentials or `raw` provider bodies. Non-kit errors (programmer bugs) are rethrown to the developer.
- `beforeExecute(ctx)` receives `{ connector, action, effect, input (validated), connectionId }` and returns `{ allow: true }` or `{ allow: false, reason? }`. It may be async (e.g. wait for a human). It runs once per call, after validation and before any network I/O, not per retry.
- Denial yields `ConnectorKitError` code `denied`. **Fail closed:** if the hook throws, the action does not run.
- The host-supplied `reason` is shown to the model, so hosts should not put secrets in it.

## Why
One connector definition serves developers and agents; the host owns policy; failures stay readable for models while sensitive detail stays out.

## Trade-offs
Tool output size is bounded only by the response cap and page size; large results still consume model context. `only` is the lever for tool-count bloat. MCP is not included yet: it is a thin adapter over the same `Tool[]`.

## When we may revisit
When adding an MCP server adapter, result truncation for models, or per-tool approval metadata beyond `effect`.
