# ADR-009: Designed error taxonomy

- Status: accepted
- Date: 2026-09-21

## Problem
Every provider reports errors differently; agents need errors they can read and act on.

## Decision
A small normalized set: `auth_expired`, `rate_limited`, `not_found`, `invalid_input`, `upstream_error` (extensible). Each error carries `code`, `retryable`, a model-readable `message`, and optional `retryAfter`. Raw provider details are kept in a separate field that adapters do not forward to models by default.

## Why
Predictable errors let agents self-correct and let hosts branch on `code`.

## Trade-offs
Some provider nuance is lost in normalization; raw details remain available to developers.

## When we may revisit
As real connectors reveal missing categories.
