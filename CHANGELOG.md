# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/) from 0.1.

## [0.7.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.6.0...v0.7.0) (2026-10-14)


### Features

* add zoho-crm connector ([#66](https://github.com/itzzzzzzak/connector-kit/issues/66)) ([98e0d37](https://github.com/itzzzzzzak/connector-kit/commit/98e0d37dbcb3b2ba091aba2ed46393ce23cc6be0))

## [0.6.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.5.0...v0.6.0) (2026-10-13)


### Features

* add Dropbox connector ([#53](https://github.com/itzzzzzzak/connector-kit/issues/53)) ([e236c5f](https://github.com/itzzzzzzak/connector-kit/commit/e236c5fc727a452bcf89ce12bf5c0731118c82d4))
* add Outlook, OneDrive and Microsoft Teams connectors ([#50](https://github.com/itzzzzzzak/connector-kit/issues/50)) ([a73e325](https://github.com/itzzzzzzak/connector-kit/commit/a73e32597f0fd395cf4c9531610acdbb1faa8665))
* add Resend and SendGrid connectors ([#52](https://github.com/itzzzzzzak/connector-kit/issues/52)) ([e54d912](https://github.com/itzzzzzzak/connector-kit/commit/e54d912fec64b6c8f113e6aa24c88213095189d8))

## [0.5.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.4.0...v0.5.0) (2026-10-12)


### Features

* add Notion connector, cursor paging in a POST body and JSON OAuth token requests ([#37](https://github.com/itzzzzzzak/connector-kit/issues/37)) ([d6ecf76](https://github.com/itzzzzzzak/connector-kit/commit/d6ecf764cdd5f5f79e67127f952c2266ae3b2524))
* add Stripe connector, form-encoded bodies, idempotency keys and last-item paging ([#35](https://github.com/itzzzzzzak/connector-kit/issues/35)) ([55e9ae5](https://github.com/itzzzzzzak/connector-kit/commit/55e9ae528e8c5bc83f34697e212a1f5c05dd1931))
* add the Discord connector ([#43](https://github.com/itzzzzzzak/connector-kit/issues/43)) ([fbdb1a6](https://github.com/itzzzzzzak/connector-kit/commit/fbdb1a648b9ff8a19be2964556ef3bf1602901af))
* add the Linear connector and GraphQL actions ([#38](https://github.com/itzzzzzzak/connector-kit/issues/38)) ([aacbb9f](https://github.com/itzzzzzzak/connector-kit/commit/aacbb9f4b5c4e6904e99eb242a796f9f228356e6))
* add the Salesforce connector ([#40](https://github.com/itzzzzzzak/connector-kit/issues/40)) ([b4dcef3](https://github.com/itzzzzzzak/connector-kit/commit/b4dcef34ed07a3004a993dbef5d00a2e632bc7ad))
* add the Shopify connector ([#42](https://github.com/itzzzzzzak/connector-kit/issues/42)) ([82d7ea6](https://github.com/itzzzzzzak/connector-kit/commit/82d7ea6c69a9f5f0ff44986360caaad67dee57d3))
* add the Twilio, Twilio Verify and Twilio Lookups connectors ([#41](https://github.com/itzzzzzzak/connector-kit/issues/41)) ([7bc7630](https://github.com/itzzzzzzak/connector-kit/commit/7bc763021dff521abd4af4bc09a6174d9ddb6fd8))
* add thirteen Google Workspace connectors ([#39](https://github.com/itzzzzzzak/connector-kit/issues/39)) ([958a25a](https://github.com/itzzzzzzak/connector-kit/commit/958a25ac5c84edf94ad2ad738a7a5e1a713e6e1d))
* Datadog connector with two-key auth ([#44](https://github.com/itzzzzzzak/connector-kit/issues/44)) ([14caa29](https://github.com/itzzzzzzak/connector-kit/commit/14caa294a725dee66f3b89762e8dcdc43e083e71))


### Performance Improvements

* stop the type check running out of memory (5 GB to 1.6 GB) ([#36](https://github.com/itzzzzzzak/connector-kit/issues/36)) ([ddcf7bc](https://github.com/itzzzzzzak/connector-kit/commit/ddcf7bc76a9d94dedad78bc16c31a55c44560225))

## [0.4.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.3.0...v0.4.0) (2026-10-11)


### Features

* full API coverage by group; OpenAPI generator; GitHub REST API (1,190 actions) ([#29](https://github.com/itzzzzzzak/connector-kit/issues/29)) ([00a0a03](https://github.com/itzzzzzzak/connector-kit/commit/00a0a031bb2756f1251415be7e6e1b45994ae5d9))
* full API coverage for GitLab, Jira, DigitalOcean, Zendesk, Vercel, PagerDuty, Sentry, Slack, Asana, ClickUp, Netlify, Intercom, Figma ([#31](https://github.com/itzzzzzzak/connector-kit/issues/31)) ([5507bb4](https://github.com/itzzzzzzak/connector-kit/commit/5507bb463a373dbbdf035f73cfdaa0733f98636a))
* full API coverage for HubSpot, Zoom, Pipedrive, Mailchimp; multi-spec generator ([#32](https://github.com/itzzzzzzak/connector-kit/issues/32)) ([999e742](https://github.com/itzzzzzzak/connector-kit/commit/999e742d9a97919a781c342cfcd5790978e48cb3))

## [0.3.0](https://github.com/itzzzzzzak/connector-kit/compare/v0.2.0...v0.3.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* PaginationStrategy replaced urlForCursor with applyCursor and nextCursor now receives the body (custom strategies must be updated).

### Features

* add Asana, HubSpot, Airtable and Calendly connectors ([#24](https://github.com/itzzzzzzak/connector-kit/issues/24)) ([dc822a0](https://github.com/itzzzzzzak/connector-kit/commit/dc822a01114fd48c5de47f7c09ece441741694ea))
* add Vercel, Pipedrive, Intercom and Figma connectors ([#26](https://github.com/itzzzzzzak/connector-kit/issues/26)) ([de001be](https://github.com/itzzzzzzak/connector-kit/commit/de001beb477c8053f2167b1d9f520a61b691c709))
* add Zoom, GitLab, Netlify and DigitalOcean connectors ([#25](https://github.com/itzzzzzzak/connector-kit/issues/25)) ([57569f8](https://github.com/itzzzzzzak/connector-kit/commit/57569f8743dae38324590c11f8e861d6a26643c2))
* base-URL variables, HTTP Basic auth, and the Zendesk and Jira connectors ([#27](https://github.com/itzzzzzzak/connector-kit/issues/27)) ([fcd9c75](https://github.com/itzzzzzzak/connector-kit/commit/fcd9c757d690bd164206bb73ec2c4c4e37eb42c0))
* connector foundation (metadata, conformance check, scaffold, generated catalog) ([#23](https://github.com/itzzzzzzak/connector-kit/issues/23)) ([17ab0ec](https://github.com/itzzzzzzak/connector-kit/commit/17ab0eca478b494eda19a90cc6ff1e2153eac62b))
* offset/page and Link-header-cursor pagination; add PagerDuty, Mailchimp, ClickUp, Sentry connectors ([#28](https://github.com/itzzzzzzak/connector-kit/issues/28)) ([5ede3b1](https://github.com/itzzzzzzak/connector-kit/commit/5ede3b1c9583db2dfc9fbceb872f58c15091ef0a))
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
