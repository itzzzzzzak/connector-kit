# Maintaining connector-kit

How this repository is run. Written for the maintainer (and anyone who becomes one). When practice and this document disagree, fix one of them in the same PR.

Contents: [Principles](#principles) · [One-time repository setup](#one-time-repository-setup) · [Branching model](#branching-model) · [Everyday workflow](#everyday-workflow) · [Reviewing and merging](#reviewing-and-merging) · [Releases](#releases) · [Hotfixes and backports](#hotfixes-and-backports) · [Versioning policy](#versioning-policy) · [Issues and triage](#issues-and-triage) · [Security reports](#security-reports) · [Dependencies](#dependencies) · [Decisions (ADRs)](#decisions-adrs) · [Routine checklists](#routine-checklists) · [Bus-factor notes](#bus-factor-notes)

## Principles

1. **`main` is always releasable.** Green CI, no half-finished work. Anything unfinished lives on a branch.
2. **GitHub is the source and the distribution channel.** There is no npm package. People install a tarball from a GitHub Release (see [ADR-012](docs/adr/0012-github-distribution-single-package.md)). What is in the repository and its Releases *is* the product.
3. **Everything goes through a PR,** including the maintainer's own changes. CI is the second opinion that catches what "works on my machine" hides.
4. **Safety rules are tested, not trusted.** Changes to validation, retries, secrets handling, or the policy hook need a test that fails when the rule is removed (see "Mutation check" below).
5. **Small, reviewable PRs.** One concern per PR. A PR you cannot explain in two sentences is two PRs.
6. **Decisions are written down** (ADRs), so future contributors can see *why*, not just *what*.
7. **Verify the install, not just the tests.** Unit tests passing does not mean a stranger can install and use the library. `pnpm smoke` does that, and CI runs it.

## One-time repository setup

Most of this is already done; use it as an audit checklist.

**GitHub settings** (repo → Settings)

- [x] Description and topics set. Default branch is `main`.
- [x] "Automatically delete head branches" on.
- [x] Private vulnerability reporting on (Settings → Code security). `SECURITY.md` depends on it.
- [ ] **Merge button: Squash and merge only.** Disable merge commits and rebase merging. The squash commit takes the PR title, and the release tooling reads those titles, so this is not just taste.
- [ ] **Allow GitHub Actions to create pull requests** (Settings → Actions → General → Workflow permissions → "Read and write permissions" + the checkbox). Required for the release workflow to open the "release" PR.
- [ ] **Branch protection on `main`** (Settings → Branches), or via the CLI:

  ```bash
  gh api -X PUT repos/itzzzzzzak/connector-kit/branches/main/protection --input - <<'JSON'
  {
    "required_status_checks": { "strict": true, "contexts": ["check (22)", "check (24)", "package"] },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  JSON
  ```

  With one maintainer, required reviews would block merging your own PRs, so none are required; CI and "no force-push" are the guardrails. Add `required_pull_request_reviews` when there is a second maintainer.
- [ ] **Optional, recommended: a token so CI runs on release PRs.** PRs opened by the default `GITHUB_TOKEN` do not trigger workflows, so with required checks the release PR would show no checks. Create a fine-grained personal access token (this repo only; Contents + Pull requests: read/write) and store it as the repo secret `RELEASE_PLEASE_TOKEN`. The workflow uses it automatically when present. Without it, close and reopen the release PR to trigger CI.
- [ ] Optional: enable Discussions for questions, so Issues stay actionable.

## Branching model

Trunk-based, deliberately simple.

| Branch | Purpose | Lifetime |
|---|---|---|
| `main` | Always releasable. All PRs target it. | Permanent |
| `feat/<topic>` | New functionality | Until merged |
| `fix/<topic>` | Bug fixes | Until merged |
| `docs/<topic>`, `chore/<topic>` | Docs, tooling, CI | Until merged |
| `release-please--*` | Opened and updated automatically by the release workflow | Until the release PR is merged |
| `release/<major>.<minor>` | **Only** created when an old version needs a backported fix after `main` has moved on (see [Hotfixes](#hotfixes-and-backports)) | Rarely exists |

There is no `develop` branch and no long-lived release branch by default. A *release* is a git tag plus a GitHub Release with a tarball, produced from `main` by automation (below), not a branch.

Stacked PRs (a PR whose base is another feature branch) are allowed but must say so in the description. Merge the base first, then retarget the child to `main`: `gh pr edit <n> --base main`.

## Everyday workflow

1. Branch from an up-to-date `main`: `git switch main && git pull && git switch -c feat/thing`.
2. Make the change **with tests**, including failure paths (expired token, `429`, `5xx` on a write, malformed JSON).
3. Run locally: `pnpm typecheck && pnpm test` (see "Checking the test count"), and `pnpm smoke` if you touched `package.json`, exports, or the build.
4. Update docs: README if behavior changed, an ADR if a decision changed, `docs/notebook.md` for failures and lessons.
5. Open a PR using the template. **The title drives the release**, so use `type: short summary` where type is `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, or `ci`. A `!` as in `feat!:` marks a breaking change.

**Checking the test count.** A green run can run nothing: once a glob matched 1 test instead of 8 and still passed. After changing test wiring, confirm the *number* of tests run matches expectations.

**Mutation check (for safety-critical code).** After writing a test for a safety rule, temporarily break the rule and confirm *that* test fails, then restore. A test that cannot fail protects nothing. Make each mutation change exactly one behavior; a mutation that breaks syntax proves nothing.

## Reviewing and merging

**Review checklist** (also in the PR template)

- [ ] Does CI pass on both Node versions and the `package` job? Read the log if not; don't guess.
- [ ] Are there tests for failure paths, not just the happy path?
- [ ] Could a model or untrusted caller misuse this? (path/URL injection, oversized input or output, prompt-injectable text, retrying a non-idempotent write)
- [ ] Could a secret end up in an error, log, or tool result?
- [ ] Is the public API change intentional and documented? Is the PR title right (`feat!:` if breaking)?
- [ ] Does the change keep the invariants: *the core knows nothing about agents; adapters know nothing about providers; every call goes through `execute`*?
- [ ] New connector? Does it follow the checklist in [CONTRIBUTING.md](CONTRIBUTING.md)?

**Merging**

- Squash and merge, and make sure the squash title is the clean PR title.
- Never force-push `main`. Never merge with red CI.
- Do not merge a PR you have not read just because CI is green: CI proves the tests pass, not that the tests are the right ones.

## Releases

A release is a git tag + a GitHub Release with a prebuilt tarball. It is automated with [release-please](https://github.com/googleapis/release-please); you decide *when* by merging one PR.

### How a change gets released

1. **Feature PRs merge to `main`** with conventional titles (`feat: ...`, `fix: ...`).
2. **The `Release` workflow** keeps a PR open titled **"chore(main): release x.y.z"**. It contains the version bump in `package.json` and a generated `CHANGELOG.md` section built from the squash-merged titles since the last release.
3. **Cut the release = merge that PR.** release-please then creates the tag (`vX.Y.Z`) and the GitHub Release.
4. **The workflow's second job** checks out the tag, runs typecheck, tests and the install smoke test, builds the package, and attaches `connector-kit-X.Y.Z.tgz` and `SHA256SUMS` to the Release.
5. **Verify** (checklist below).

Because releases are batched in the release PR, you control timing: let changes accumulate, read the generated changelog, edit it if the wording is poor, and merge when you want to ship.

### How users install a release

```bash
npm install https://github.com/itzzzzzzak/connector-kit/releases/download/vX.Y.Z/connector-kit-X.Y.Z.tgz
```

`npm i github:itzzzzzzak/connector-kit#vX.Y.Z` is **not** supported: it would rely on an install-time build script, which current npm blocks until the user approves it ([ADR-012](docs/adr/0012-github-distribution-single-package.md)).

### Bump rules (pre-1.0)

| PR title | Bump |
|---|---|
| `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `minor` (while `0.x`) |
| `feat:` | `minor` while `0.x` |
| `fix:` and `perf:` | `patch` |
| `docs:`, `test:`, `refactor:`, `chore:`, `ci:` | no release on their own |
| After 1.0 | Strict semver: breaking = `major`, feat = `minor`, fix = `patch` |

When unsure whether something is breaking, treat it as breaking. A change to the error codes, `ExecuteResult` shapes, the `Tool` shape, or the connector definition format is breaking.

To force a specific version (e.g. the first one), add a commit with the footer `Release-As: 0.1.0` on `main`, or edit the release PR.

### The first release (`0.1.0`)

Cut it when the roadmap items you consider the "v0.1 promise" are done (at minimum: the README claims all hold, `pnpm smoke` passes, and the quickstart runs against the real API with a fresh token). Merge a commit with `Release-As: 0.1.0`, then merge the release PR it produces.

### Pre-releases

Tag-based pre-releases are not automated. If you need a testable build before releasing, run `pnpm build && npm pack`, send the tarball to the tester, or attach it to a draft GitHub Release marked "pre-release". Do not hand-create version tags; let release-please own them.

### Post-release verification checklist

- [ ] The Release page has the tarball and `SHA256SUMS`, and the notes read well (edit them if not).
- [ ] The checksum matches: download the tarball and `shasum -a 256` it against `SHA256SUMS`.
- [ ] In an empty folder: `npm i <release tarball URL>`, then import `connector-kit` and `connector-kit/github`, and confirm types resolve.
- [ ] The README install instructions still work with this version.
- [ ] If something is wrong: mark the Release as a pre-release (or edit its notes with a warning), fix forward, and release a patch. Avoid deleting tags or releases people may already depend on.

## Hotfixes and backports

For a bug in the **latest** version, fix it on `main` the normal way (`fix:` title); it ships when you merge the next release PR, which can be immediate.

Only if a fix must go to an **older** minor while `main` has moved on:

1. `git switch -c release/0.1 v0.1.0` and push it.
2. Cherry-pick the fix onto it, bump the patch version in `package.json` by hand, update `CHANGELOG.md`.
3. Run `pnpm typecheck && pnpm test && pnpm smoke && npm pack`, then create the GitHub Release manually from that branch (`gh release create v0.1.1 --target release/0.1 connector-kit-0.1.1.tgz`).
4. Make sure the fix is on `main` too.

Pre-1.0, supporting old minors is **not** promised. Prefer telling users to upgrade.

## Versioning policy

- [Semantic Versioning](https://semver.org). Before 1.0, breaking changes may land in minor versions and will always be called out in the changelog.
- **Public API** means what `connector-kit` exports from its entry point and each `connector-kit/<name>` subpath, the connector definition format, the error codes and their `retryable` semantics, and the `Tool`/`ToolResult` shapes. Internals (anything not exported) can change in a patch.
- Deprecate before removing, when practical: keep the old form for at least one minor version, mark it `@deprecated`, and note it in the changelog.
- Supported Node versions follow the `engines` field and the CI matrix; dropping a Node version is a breaking change.
- All connectors share the library's version. A connector fix is a library release.

## Issues and triage

New issues arrive with `needs triage`. Within a few days, a maintainer should:

1. Reproduce or ask for a minimal reproduction (redact tokens!).
2. Label it: `bug`, `enhancement`, `connector request`, `question`, `documentation`, `breaking change`, `adr`, `type: security`.
3. Close duplicates (`duplicate`) and out-of-scope requests (`wontfix`) politely, pointing at the non-goals in the README.
4. Mark approachable work `good first issue` or `help wanted`, with a short pointer to where in the code to start.

Be kind and specific: contributors are volunteers. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security reports

Reports arrive privately (Security tab → advisories). Handle them as follows:

1. Acknowledge within a few days. Reproduce, assess severity, and agree a disclosure timeline with the reporter.
2. Develop the fix in a **private fork/branch** attached to the advisory, not in a public PR.
3. Release a patch version, then publish the advisory (credit the reporter if they agree) and request a CVE if warranted. Because there is no registry to push a fix to users, say clearly in the advisory which Release contains the fix and how to upgrade.
4. Add a regression test and a `docs/notebook.md` entry under "Failures".

Security-sensitive areas to review with extra care: token storage and encryption, OAuth `state`/PKCE, URL/path construction, the policy hook, error and tool output (no secrets), response size limits.

## Dependencies

- Dependabot opens weekly grouped PRs for npm and GitHub Actions. Review the changelog of each; merge when CI is green.
- Keep runtime dependencies minimal (currently only `zod`); each one is a supply-chain surface for every user. Adding one needs justification in the PR.
- Never add a dependency that runs install scripts without reading them.
- `pnpm-lock.yaml` is committed; CI uses `--frozen-lockfile`, so a PR that changes dependencies must include the updated lockfile.
- Pin GitHub Actions to a trusted major version (done) and review Dependabot's action bumps.

## Decisions (ADRs)

Any change that affects the architecture, the public API, a safety rule, or a trade-off future contributors will ask "why?" about gets an ADR in `docs/adr/` (copy `0000-template.md`, next number, status `proposed` → `accepted`). Superseded decisions are marked, not deleted. Lessons from bugs and mistakes go in `docs/notebook.md` ("Failures", "Mistakes").

## Routine checklists

**Per PR (maintainer):** read the diff → CI green (both Node versions + `package`) → tests cover failure paths → docs/ADR updated → squash-merge with a clean `type: summary` title.

**Weekly (about 30 minutes):** triage new issues → review Dependabot PRs → check that `main` CI is green → if the release PR has accumulated meaningful changes, decide whether to ship it.

**Before a release:** read the generated changelog → run the quickstart against the real API with a fresh token (`pnpm build && GITHUB_TOKEN=... pnpm example:quickstart`) and the opt-in live tests (`GITHUB_TOKEN=... pnpm test`) → `pnpm smoke` → confirm the README examples still match the API → merge the release PR.

**Quarterly:** re-read the ADRs for any that no longer hold; review the roadmap against what users actually asked for; rotate `RELEASE_PLEASE_TOKEN` if used; check supported Node versions.

## Bus-factor notes

Anything only the maintainer knows is a risk. Keep these current so another person could take over:

- Releases are cut by merging the release PR (nothing runs from a laptop). The tarball is built by CI, not by hand.
- The live smoke tests need a personal `GITHUB_TOKEN` and are skipped in CI.
- The design intent is in `docs/notebook.md` and `docs/adr/`, not in anyone's head.
- If `RELEASE_PLEASE_TOKEN` is used, note who owns it and when it expires.
