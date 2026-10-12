# ADR-026: Microsoft 365 as three hand-written connectors over Microsoft Graph

- Status: accepted
- Date: 2026-10-12

## Problem
Microsoft 365 is reached through one API, Microsoft Graph, with thousands of operations across mail, calendar, files, Teams, directory and more. The published description is very large, and much of it needs administrator consent or application permissions that a single end user cannot grant.

## Alternatives considered
- Generate the whole Graph API with the OpenAPI generator, as for GitHub or Stripe. Rejected for now: the description is too large to review, most of it is directory and admin operations an agent should not reach by default, and it would bury the few calls people use.
- One connector for all of Microsoft 365. Rejected: each product has its own scopes, and a host that only wants mail should not hand an agent file-deleting tools (the same reasoning as ADR-022 for Google).

## Decision
- Three connectors, `outlook` (mail, calendar, contacts), `onedrive` and `microsoft-teams`, each hand-written and typed, 8 to 13 actions, all delegated (signed-in user) permissions.
- `src/microsoft.ts` holds the shared OAuth setup (the `common` tenant, `offline_access` for refresh tokens, PKCE) and `graphPage()`, which pages with `$top` and follows the full URL in `@odata.nextLink` through `bodyLinkPagination`. A next link to another host is refused by the base-URL check.
- Query options are plain input names (`search`, `filter`); the `$` is added in `buildQuery`. Mail `search` and `filter` cannot be combined, as Graph does not allow it; the input says so and rejects both together.
- Sending mail, posting to Teams and creating events with attendees reach real people, so their descriptions tell the model to ask a human; deleting and the recycle-bin style removals are `destructive`. OneDrive search puts the query in a path function, so a query containing a single quote is rejected.
- Not covered: file upload and download, SharePoint sites and libraries, the directory (users, groups), application permissions, Teams meetings, and a tenant-specific sign-in (auth URLs cannot take a placeholder yet).

## Why
It covers what most hosts and agents use (read and send mail, find a time, find and share a file, read and post in Teams) with small, reviewable tool lists.

## Trade-offs
Work and school accounts often need an administrator to consent to the Teams read scopes, and the `common` tenant does not fit an app registered for a single tenant. All three are `docs-based`: they have not been run against a real tenant.

## When we may revisit
Generating selected Graph areas (users, groups, SharePoint) with a curated path list; tenant-specific OAuth URLs.
