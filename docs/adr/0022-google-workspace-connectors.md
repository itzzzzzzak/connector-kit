# ADR-022: Google Workspace as thirteen connectors, generated from Discovery documents

- Status: accepted
- Date: 2026-10-12

## Problem
"Google Workspace" is not one API. Gmail, Calendar, Drive, Sheets, Docs and the rest each have their own host, version, scopes and rate limits, and Google describes them in Discovery documents, not OpenAPI. We want every Workspace API an agent is likely to need, kept up to date without hand-copying.

## Alternatives considered
- One `google-workspace` connector with all of it. Rejected: it would need a base URL per action (the kit has one per connector), would put roughly 700 actions in front of a model, and would force one set of scopes on every use.
- Hand-write each API. Rejected: Admin and Classroom alone have over 200 calls each.
- Hand-write only a few popular calls. Rejected for the same reason ADR-018 rejected it: the long tail is what people ask for next.

## Decision
- One connector per API: `gmail`, `google-calendar`, `google-drive`, `google-sheets`, `google-docs`, `google-slides`, `google-tasks`, `google-people`, `google-forms`, `google-meet`, `google-chat`, `google-admin`, `google-classroom`. They share one OAuth setup (`googleAuth` in `src/google.ts`: PKCE, `access_type=offline` and `prompt=consent` so a refresh token is issued, `include_granted_scopes`), and each asks for the narrowest scope that makes it useful. The host can override scopes per connection.
- `scripts/discovery-to-openapi.mjs` converts a Discovery document to an OpenAPI object in memory and `scripts/gen-openapi.mjs` takes it from there (ADR-018). Descriptions are written by this project (`descriptions: "derived"`), because the documents declare no license. Outputs are left open (`z.unknown()`) on the generated actions.
- A curated, typed layer is written by hand where an agent starts: Gmail search, read and send (the kit builds the MIME message, and refuses a line break in any header), Calendar events and free/busy, Drive search and sharing, Sheets values, Docs edits, Tasks, Chat messages, Contacts, Admin reads. A hand-written action replaces the generated one with the same method and path.
- The path placeholder `{+name}` (Google's reserved expansion) takes a value that is itself a path ("people/c123", "spaces/AAA"). Each segment is encoded and slashes stay; an empty, `.` or `..` segment is refused. A path parameter with a documented stand-in (`userId` is "me") can default to it (`pathDefaults` in the generator config).
- Left out: media upload and download (binary bodies), and `files.export`. Drive is managed as metadata: folders, names, parents, trash, sharing. The conformance check accepts "trash", "purge", "wipe", "suspend", "clear", "block", "stop" and "empty" as words that describe something destroyed.

## Why
It follows the same pattern as every other large connector, so reviewers already know it. Splitting by API keeps a model's tool list short and lets a host grant Gmail without Drive.

## Trade-offs
Generated outputs are untyped, and the descriptions are short. The hand-written layer is where quality lives, and it covers the common cases only. All thirteen are `docs-based`: tested against a fake server, not run against Google.

## When we may revisit
Service-account and domain-wide-delegation auth for Admin and Chat apps; multipart upload for Drive; Apps Script, Keep, Vault and Reports.
