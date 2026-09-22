# ADR-002: Ship as a library, not a server

- Status: accepted
- Date: 2026-09-21

## Problem
Should v0.1 be an embeddable package or a standalone service with an HTTP API?

## Alternatives considered
Standalone service; library with an optional server adapter later.

## Decision
A library. Any server or MCP endpoint is an adapter built on top.

## Why
Lowest adoption cost (`npm install`), no infrastructure to operate, and matches both target users.

## Trade-offs
Each host app runs its own instance, so cross-process concerns (rate-limit state, refresh locks) must go through the shared store.

## When we may revisit
If users need a language-agnostic hosted gateway.
