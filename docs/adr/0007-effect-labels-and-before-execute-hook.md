# ADR-007: Effect labels plus an optional `beforeExecute` hook

- Status: accepted
- Date: 2026-09-21

## Problem
Some actions are dangerous (destructive writes). Who decides whether an agent may run them?

## Alternatives considered
Kit enforces approvals; kit only labels; kit labels and offers a hook.

## Decision
Every action carries `effect: "read" | "write" | "destructive"`. The host may supply `beforeExecute(ctx)` returning allow/deny. The kit ships no policy of its own; without a hook, actions run.

## Why
Business rules differ per host. The kit provides the mechanism, the host owns the policy. This is also where MCP Gatekeeper will later plug in.

## Trade-offs
Safe defaults are the host's responsibility; documentation must make this clear.

## When we may revisit
If a safe-by-default mode (deny destructive unless a hook is set) proves necessary.
