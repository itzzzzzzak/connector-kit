# ADR-004: Declarative connectors with handler escape hatches

- Status: accepted
- Date: 2026-09-21

## Problem
Most APIs fit a declarative description, but some are unusual (async export jobs, odd pagination).

## Alternatives considered
Purely declarative (YAML/JSON); purely code; declarative by default with code overrides.

## Decision
`defineConnector({...})` in TypeScript. Actions are declarative by default (method, path, schemas, pagination) and may supply a `handler(ctx, input)` for unusual APIs. Handlers must use `ctx.http` so they inherit auth, retries and rate limiting.

## Why
Code gives type inference; declarative defaults keep connectors short and easy for people and LLMs to author; the `ctx.http` rule preserves the kit's value inside escape hatches.

## Trade-offs
Code connectors are less safe to load from untrusted sources than data files.

## When we may revisit
If a data-file format is needed for connector marketplaces or user-uploaded connectors.
