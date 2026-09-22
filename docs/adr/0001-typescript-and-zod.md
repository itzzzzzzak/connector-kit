# ADR-001: TypeScript with Zod as the schema source of truth

- Status: accepted
- Date: 2026-09-21

## Problem
Connectors need input/output schemas that serve developers (types), the runtime (validation) and LLMs (JSON Schema for tool calling and MCP).

## Alternatives considered
Python with Pydantic; TypeScript with hand-written types plus a separate JSON Schema; TypeScript with Zod.

## Decision
TypeScript, with Zod schemas as the single source of truth.

## Why
One schema yields compile-time types, runtime validation and JSON Schema. The MCP SDK and most SaaS/web developers are in the TypeScript ecosystem.

## Trade-offs
Excludes Python-first users (could be served later via an HTTP wrapper). Zod adds a runtime dependency.

## When we may revisit
If Python demand dominates, or Zod's JSON Schema output proves inadequate.
