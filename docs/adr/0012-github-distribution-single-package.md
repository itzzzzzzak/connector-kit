# ADR-012: Distribute from GitHub as a single package

- Status: accepted
- Date: 2026-10-08

## Problem
We will not publish to npm; GitHub is the source and the distribution channel. The first layout (a pnpm monorepo with `@connector-kit/core` and `@connector-kit/github`) assumed a registry: two packages, a peer dependency, two URLs to install. How should people install and extend the library?

## Alternatives considered
- Keep the monorepo and attach two tarballs per release (more moving parts for every user).
- `npm i github:owner/repo` with a `prepare` build script. **Rejected after testing:** current npm blocks a dependency's install scripts until the user approves them (`allow-scripts` warning), so a git install would ship unbuilt.
- GitHub Packages npm registry: requires an auth token even to install public packages.
- One package, prebuilt, attached to each GitHub Release as a tarball.

## Decision
One package named `connector-kit` (marked `private` so it cannot be published to npm by accident). The core is the package root; each connector is a subpath export (`connector-kit/github`, source in `src/connectors/<name>/`). Releases are git tags + GitHub Releases with a prebuilt `.tgz` and `SHA256SUMS` attached; users install the tarball URL. `prepack` (not `prepare`) builds, so consumers never run install scripts.

Versioning is automated by release-please from squash-merged PR titles (conventional `feat:`/`fix:`), which also writes `CHANGELOG.md`, the tag and the release.

A smoke test (`pnpm smoke`, run in CI and before attaching the tarball) packs the library, installs it into an empty project, imports every entry point, generates tools, and checks no test files shipped.

## Why
One install line for users. New connectors are a folder in a PR (no new package, version or publish step). The tarball works in npm, pnpm, yarn and bun without scripts.

## Trade-offs
All connectors share one version and one package, so a connector fix is a library release. Unused connectors ship in the tarball (about 16 kB now; `sideEffects: false` and subpath imports keep bundles small). Zod is a regular dependency, so apps and the library share a Zod 4 copy.

## When we may revisit
If the connector catalog grows large enough that install size or release cadence hurts, split connectors into separate packages (the subpath layout makes that mechanical), or publish to a registry if the project decides to.
