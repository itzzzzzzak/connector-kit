# ADR-006: The host app owns the OAuth callback

- Status: accepted
- Date: 2026-09-21

## Problem
A user must be able to authorize a provider and the kit must receive the resulting code.

## Decision
The kit runs no server. It exposes `startAuth(connector, { connectionId })` (returns the authorization URL) and `finishAuth(connector, { code, state })` (exchanges the code and stores tokens). The host wires these to its own routes and registers its own redirect URI with the provider.

## Why
Fits the library model (ADR-002) and keeps redirect URIs under the host's control.

## Trade-offs
Every host must implement two routes. The kit must generate and verify `state`, and should support PKCE.

## When we may revisit
If a hosted or CLI login helper is needed.
