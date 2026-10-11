# ADR-018: Full API coverage, exposed by group

Status: accepted

## Context
ADR-016 chose "curated, 5-15 actions per connector (hard cap 40)" because a model chooses worse from a long tool list. The maintainer's goal is different: every connector should cover the provider's whole API, as Nango does, so nothing a developer needs is missing. Both are right: coverage belongs to the **connector**, selection belongs to the **caller**.

## Decision
- A connector may have any number of actions (the checker only stops at an absurd 2,000).
- Actions are grouped by the part of their name before the first dot (`issues.create` is in `issues`). `toTools(connection, { groups: ["issues"] })` and `connector-kit-mcp <name> --group issues,repos` expose a group; `--only` still picks single actions.
- The MCP command **refuses to start** for a connector with more than 40 actions unless `--group` or `--only` is given, and prints the groups with their sizes. A model is never handed hundreds of tools by accident.
- Where a provider publishes an official, permissively licensed OpenAPI description, `scripts/gen-openapi.mjs` turns it into plain TypeScript under `src/connectors/<name>/generated/` (committed and reviewable; the license is recorded in each file). Inputs (path, query and top-level body fields) are typed from the spec. Responses are left open (`z.unknown()`), because response schemas in specs are large and often slightly wrong. Deprecated operations and non-JSON bodies (file uploads) are skipped, and the generator reports how many.
- A hand-written action with the same name wins over a generated one, so important actions can have typed outputs and tested behaviour. The generator's config lists the paths already written by hand.
- Paginated list operations (a `per_page` and `page` parameter and an array response) get the kit's pagination; other lists keep the provider's own paging parameters as ordinary inputs.
- Tool names must be at most 64 characters; the generator abbreviates long operation names deterministically.

## Safety
Generated actions follow the same rules as hand-written ones: GET is read, DELETE is destructive and never exposed through the MCP command, other methods are writes (read-only by default there), and **none is marked safe to retry**. `src/generated.test.ts` runs every generated action against a fake server and checks method, path encoding, and that every input field reaches the provider exactly once.

## Consequences
GitHub went from 2 to 1,192 actions. Generated actions are `docs-based` at best, however many there are: the status describes verified behaviour, not volume. Generated descriptions are the spec's own summaries and are less tailored for a model than hand-written ones; this is the cost of coverage.

## Provider text and licenses
Endpoint paths, parameter names and types are facts about an API and are taken from the provider's official description. The *prose* (summaries and parameter descriptions) is copyrightable, so it is copied only when the description is under a permissive license that allows it (MIT or Apache 2.0, recorded in the header of every generated file): GitHub, Figma, DigitalOcean, Intercom, Slack, Netlify, Jira, Asana. For specs with no declared license or a restrictive one (GitLab, ClickUp, Zendesk, PagerDuty, Vercel, Sentry's Functional Source License), the generator writes its own short description from the operation name, tag and path and leaves parameter descriptions out (`"descriptions": "derived"` in the config). These are weaker for a model than the provider's prose; hand-written actions are the way to improve the ones that matter.

## Known limits of generated actions
- Skipped: deprecated operations, file uploads and other non-JSON bodies, operations that need a custom header (PagerDuty writes need `From`), query parameters that are objects, operations outside the connector's base path (some Jira and DigitalOcean products), and paths with odd characters. The generator prints how many of each.
- Slack's Web API documents form-encoded bodies; the generator sends JSON (Slack accepts it for most methods) and accepts a structure where Slack documents "a JSON string". This is unverified against the live service.
- Lists get kit pagination only where the rule in the generator config recognises the provider's convention and the response has exactly one list; other lists expose the provider's own paging parameters as ordinary inputs.
