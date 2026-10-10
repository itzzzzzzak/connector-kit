# Writing a connector

A connector describes one provider's API so that apps and AI agents can call it safely. The runtime handles auth, retries, rate limits, pagination, and errors; **you describe what the API looks like, truthfully.** Read this before writing one, and read a finished one (`src/connectors/github`, `src/connectors/slack`).

## The two statuses, and the rule about honesty

| Status | Meaning | Who may claim it |
|---|---|---|
| `docs-based` | Written from the provider's official documentation and tested against a fake server. **Not run against the real service.** | Anyone, by default. |
| `live-tested` | Its actions were run against the real API with a real account. | Only after someone actually did, with evidence in the PR. |

**Never mark a connector `live-tested` because it looks right.** A wrong field name or scope is invisible to a fake server and obvious to the first real user, and one such user costs the whole catalog its credibility. Honest `docs-based` connectors are valuable; false `live-tested` ones are harmful.

## 1. Scaffold

```bash
pnpm install
pnpm new:connector acme       # creates src/connectors/acme/ and adds the package export
pnpm test                     # fails until every TODO is replaced: that is intentional
```

The folder name, the connector's `name`, and the import path (`connector-kit/acme`) are the same word.

## 2. Gather facts from the OFFICIAL documentation

- Use the provider's own API reference (put it in `meta.docsUrl`). Do not rely on memory, blog posts, or other SDKs.
- Write descriptions **in your own words**. Do not paste documentation text: docs are copyrighted and we publish under MIT.
- Check four things before writing any code: how requests authenticate, how lists paginate, how errors are reported (HTTP status, or inside a 200?), and what the rate-limit headers are.

## 3. Choose the actions: curate, do not mirror

An agent that sees 300 tools chooses worse than one that sees 10. Pick the **5-15 actions** that apps and agents use most (the checker rejects more than 40).

- Prefer reads. Add writes only where the value is clear, and expect each to be gated by the host's policy.
- Skip admin, billing, and bulk-destructive endpoints unless you can say who needs them.
- Each action is one `resource.verb` (`issues.list`, `chat.postMessage`).

## 4. Describe each action for a model

The `description` is what an LLM reads to decide whether to call the tool, **on every request**. Say what it returns and **when to use it**; for writes, say what it changes and who will see it.

```ts
description: "List issues in a repository. Use when the user asks what is open or what was reported. Returns one bounded page; pass nextCursor for more."
```

If the content can come from other people (messages, tickets, comments), say it is data, not instructions.

## 5. Schemas

- **Inputs are strict.** Required fields required, `.describe()` on non-obvious ones, sensible `max` lengths. Every path parameter (`/repos/{owner}/{name}`) must be a **required** input.
- **Outputs list only fields you are sure of; mark the uncertain ones `.optional()`.** The kit validates responses, so a field you invented as required makes every real call fail. Extra fields are dropped.
- Keep outputs small: the model pays for every field.

## 6. `effect` and retries

| `effect` | Use for | Rule enforced by the checker |
|---|---|---|
| `read` | Anything that only fetches | A `GET` must be `read` |
| `write` | Creates or changes data | |
| `destructive` | Deletes or cannot be undone | A `DELETE` must be `destructive` |

`safeToRetry` means *repeating the call cannot change the outcome* (a `PUT` that sets a value). **Never on a `POST`**: after a timeout you cannot know whether it already happened, and a retry could post, charge, or send twice. (A 429 is still retried: the provider did not process it.)

## 7. Auth

Pick what the provider documents: `bearer`, `apiKey` (a named header, optional prefix: `Authorization: Bot <token>`), or `oauth2`. Set `meta.credentialEnv` to the environment variable `connector-kit-mcp` should read (`ACME_TOKEN`). For OAuth, give `authorizeUrl`, `tokenUrl`, minimal default `scopes`, and set `pkce: false` if the provider does not document PKCE.

## 8. Pagination

Use a strategy from the core (`linkHeaderPagination`, `bodyCursorPagination`) rather than looping by hand. A paginated action has optional `cursor` and `pageSize` inputs, is a `GET`, and its `output` is `z.array(item)`. If no strategy fits (offset paging, last-item cursors), say so in the PR: adding a reusable strategy to the core is better than a one-off.

## 9. Errors reported inside a 200

If the provider answers `200 {"ok": false, "error": "..."}` (Slack does), implement `detectError`. Echo only short `[a-z0-9_]` error codes into messages; keep free text in `raw`.

## 10. Tests (required, and enforced)

`pnpm test` runs a check over **every** connector (`src/conformance.ts`) and requires a test file next to `index.ts`. In that file, for **every action**:

- success: correct URL, method, auth header, body, and a parsed result;
- a 404 -> `not_found`, a 429 with `Retry-After` -> `rate_limited`, a malformed body -> `upstream_error`;
- bad input is rejected and **nothing is sent**;
- for a write: a 5xx is **not** retried;
- for pagination: the second page keeps the filters; the last page returns `nextCursor: null`.

Use `harness()` from `src/connector-harness.test.ts`. Add an opt-in live test (`live.test.ts`, skipped without a token) when the API allows it.

## 11. Verifying against the real service (to reach `live-tested`)

1. Create a test account / sandbox / read-only token.
2. Run the live test (`ACME_TOKEN=... pnpm test`) and, for writes, do each action once by hand in a throwaway workspace.
3. Open a PR that changes only `status` to `live-tested`, with: the date, which actions you ran, and anything you had to fix. Fix any mismatch you found in the same PR.

Reading the actions and finding a mistake without running anything is also valuable: open an issue or PR.

## 12. Before you open the PR

```bash
pnpm typecheck && pnpm test && pnpm smoke
pnpm sync && pnpm catalog && pnpm check:generated     # package exports + docs/connectors.md
```

PR title: `feat: add <name> connector`. In the description, link the API docs page for each action and state the status honestly.

## What the automatic check enforces

Name and folder agree; base URL is https and not a placeholder; `meta` is complete with no `TODO`; description length 30-500; at most 40 actions; unique LLM tool names of at most 64 characters; every path parameter is a required input; `GET` is read and `DELETE` is destructive; no `safeToRetry` on `POST` or on reads; paginated actions have `cursor`/`pageSize` and an array output; OAuth URLs are https; the package export exists; a test file exists. It checks **shape, not truth**: whether a path actually exists at the provider is what your tests and the live check are for.
