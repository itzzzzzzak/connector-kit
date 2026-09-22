# ADR-005: Action-call path first; sync deferred

- Status: accepted
- Date: 2026-09-21

## Problem
Agents, ERPs and pipelines want different things (single typed actions vs bulk incremental reads).

## Decision
v0.1 targets the action-call path (`execute`). Bulk/incremental synchronization is deferred to SyncCore, built on top of ConnectorKit.

## Why
Agent-first users need typed, safe single actions. Trying to serve every consumer in v0.1 would deliver a mediocre everything.

## Trade-offs
Data-pipeline users are not served initially.

## When we may revisit
When SyncCore begins and needs primitives (cursors, watermarks) in the core.
