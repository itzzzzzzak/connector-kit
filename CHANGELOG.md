# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/) from 0.1.

## [0.3.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.2.0...v0.3.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* PaginationStrategy replaced urlForCursor with applyCursor and nextCursor now receives the body (custom strategies must be updated).

### Features

* add Asana, HubSpot, Airtable and Calendly connectors ([#24](https://github.com/itzzzzzzak/connector-kit/issues/24)) ([dc822a0](https://github.com/itzzzzzzak/connector-kit/commit/dc822a01114fd48c5de47f7c09ece441741694ea))
* add Vercel, Pipedrive, Intercom and Figma connectors ([#26](https://github.com/itzzzzzzak/connector-kit/issues/26)) ([de001be](https://github.com/itzzzzzzak/connector-kit/commit/de001beb477c8053f2167b1d9f520a61b691c709))
* add Zoom, GitLab, Netlify and DigitalOcean connectors ([#25](https://github.com/itzzzzzzak/connector-kit/issues/25)) ([57569f8](https://github.com/itzzzzzzak/connector-kit/commit/57569f8743dae38324590c11f8e861d6a26643c2))
* connector foundation (metadata, conformance check, scaffold, generated catalog) ([#23](https://github.com/itzzzzzzak/connector-kit/issues/23)) ([17ab0ec](https://github.com/itzzzzzzak/connector-kit/commit/17ab0eca478b494eda19a90cc6ff1e2153eac62b))
* Slack connector, body-cursor pagination, and detectError for in-band failures ([#21](https://github.com/itzzzzzzak/connector-kit/issues/21)) ([f0def2e](https://github.com/itzzzzzzak/connector-kit/commit/f0def2e5460d9e19694540ff34bddacabe80d538))

## [0.2.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.1.0...v0.2.0) (2026-10-10)


### Features

* OAuth 2.0 flow, token resolution from the store, and safe refresh ([#19](https://github.com/itzzzzzzak/connector-kit/issues/19)) ([6169f08](https://github.com/itzzzzzzak/connector-kit/commit/6169f0827fc2d6f9e8df2e5225b43ac751025d83))
* Postgres TokenStore with a cross-server lock ([#20](https://github.com/itzzzzzzak/connector-kit/issues/20)) ([a092d1b](https://github.com/itzzzzzzak/connector-kit/commit/a092d1b318ce1fc8f934078e7d9de6d1f66b6364))
* TokenStore with in-memory store and encryption at rest ([#17](https://github.com/itzzzzzzak/connector-kit/issues/17)) ([b1f0170](https://github.com/itzzzzzzak/connector-kit/commit/b1f0170b73ce298b3d38718fe6191c4628beefdd))

## 0.1.0 (2026-10-07)


### ⚠ BREAKING CHANGES

* single-package layout distributed from GitHub Releases ([#5](https://github.com/itzzzzzzak/connector-kit/issues/5))

### Features

* MCP server adapter and connector-kit-mcp command ([#12](https://github.com/itzzzzzzak/connector-kit/issues/12)) ([2086492](https://github.com/itzzzzzzak/connector-kit/commit/2086492d805d1dd4574dcaa66b14bd67eb78f72f))
* single-package layout distributed from GitHub Releases ([#5](https://github.com/itzzzzzzak/connector-kit/issues/5)) ([201ab76](https://github.com/itzzzzzzak/connector-kit/commit/201ab767dddcf58d2f6cb8cabe77c9f51c33318f))

## [Unreleased]

### Added
- Repository scaffold, design notebook and initial ADRs.
- Core vertical slice: `defineConnector`, `execute` (validate, auth, HTTP, error normalization), `createConnectorKit().connect()`.
- GitHub connector with `repos.get`.
- `kit.toTools()` (LLM tool definitions from connector actions) and the `beforeExecute` policy hook with the new `denied` error (ADR-011); opt-in live GitHub smoke tests; runnable `examples/quickstart.ts`.
- MCP server (`connector-kit/mcp`) and `connector-kit-mcp` command: read-only by default, tool annotations from `effect`, tested with the official MCP client (ADR-013).
- Single-package layout distributed from GitHub Releases (ADR-012): `connector-kit` and `connector-kit/github`, tarball install, install smoke test (`pnpm smoke`).
- Retries (ADR-008): 429 waits for `Retry-After` within a shared wait budget; 5xx/timeouts retried with jittered backoff only for reads or `safeToRetry` writes.
- Pagination (ADR-010): paginated actions return `{ items, nextCursor }`; `linkHeaderPagination()` strategy; `kit.paginate()` async iterator for developers; GitHub `issues.list`.

### Fixed
- Path parameters can no longer escape their segment (`.`, `..`, empty are rejected; final URL must stay under the base URL).
- Provider calls now time out (default 30 s) and responses are size-capped (default 1 MB).
- 403 with an exhausted rate limit is `rate_limited`; other 403s are the new `forbidden` code.
- `Retry-After` HTTP dates and `x-ratelimit-reset` are understood.
- Query arrays are sent as repeated params; objects are rejected instead of becoming `[object Object]`.
- Provider details kept in non-enumerable `error.raw`.
- Removed an unsafe cast in `connect()`; minimum Node is now 22.
