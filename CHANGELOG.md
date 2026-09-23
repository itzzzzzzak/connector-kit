# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/) from 0.1.

## [Unreleased]

### Added
- Repository scaffold, design notebook and initial ADRs.
- Core vertical slice: `defineConnector`, `execute` (validate, auth, HTTP, error normalization), `createConnectorKit().connect()`.
- GitHub connector with `repos.get`.

### Fixed
- Path parameters can no longer escape their segment (`.`, `..`, empty are rejected; final URL must stay under the base URL).
- Provider calls now time out (default 30 s) and responses are size-capped (default 1 MB).
- 403 with an exhausted rate limit is `rate_limited`; other 403s are the new `forbidden` code.
- `Retry-After` HTTP dates and `x-ratelimit-reset` are understood.
- Query arrays are sent as repeated params; objects are rejected instead of becoming `[object Object]`.
- Provider details kept in non-enumerable `error.raw`.
- Removed an unsafe cast in `connect()`; minimum Node is now 22.
