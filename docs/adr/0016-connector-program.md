# ADR-016: The connector program: hand-written, tiered, checked

- Status: accepted
- Date: 2026-10-10

## Problem
The goal is a large catalog (100-200 connectors) so the kit is useful out of the box. We cannot call real APIs we have no accounts for, hand-writing at that scale invites repeated small mistakes, and an overstated catalog ("200 connectors", all untested) would cost the project its credibility.

## Decision
- **Connectors are written by hand from the provider's official documentation** (decision of the maintainer), in the same style, one folder each (`src/connectors/<name>/`).
- **Honest status in the code and the catalog:** `live-tested` (run against the real API) or `docs-based` (official docs + fake-server tests, not run live). A connector starts `docs-based`; promotion needs evidence in a PR.
- **Consistency is enforced by tooling, not by memory:** `ConnectorMeta`, an automatic `checkConnector` run over every connector, a required test file, a scaffold command that fails until finished, generated package exports and a generated catalog (`docs/connectors.md`), all verified in CI.
- **Curated, not mirrored:** 5-15 actions per connector (hard cap 40). Agents choose worse from large tool lists.
- **Provenance:** every connector records its official `docsUrl`; descriptions are written in our own words (API descriptions are mostly unlicensed, so we do not copy their text).
- **Core features are added when a real connector needs them**, not speculatively.
- **Growth in batches of about 25**, each a reviewable PR, the first batch limited to providers that fit the current core.

## Core features the planned connectors will need
Found by surveying the providers' documented behavior (to be built just in time, each with its own tests and ADR note):

| Needed | Providers (examples) |
|---|---|
| Base URL variables (`{subdomain}`, region), validated against SSRF | Shopify, Zendesk, Jira, Mailchimp, Salesforce, Datadog |
| HTTP Basic auth (`user:password` / `email/token:key`) | Twilio, Zendesk, Jira, Mailchimp |
| Form-encoded request bodies (nested, bracket notation) | Stripe, Twilio |
| Idempotency keys (makes a POST safe to retry) | Stripe, Square, Resend |
| Offset / page-number pagination; last-item cursors | Jira, PagerDuty, ClickUp, Stripe |
| Cursor inside a POST body | Notion search, Square search, HubSpot search |
| Auth in query parameters / several headers | Trello, Datadog |
| GraphQL actions | Linear, Monday, GitHub GraphQL |

## Progress notes
- **Batch 1a, PR 1 (Asana, HubSpot, Airtable, Calendly)** was written from the providers' official specs (Asana, HubSpot, Calendly) and official reference pages (Airtable). Reading them found four more things the core could not express, each added as a small general hook with tests: `buildBody` (Asana's `{ data }` envelope), `buildQuery` (Airtable's `fields[]` and `sort[0][field]` conventions), an optional page-size parameter on pagination strategies (Airtable's base list has none), and a case-sensitive `TODO` check (a legitimate `'Todo'` status value tripped the old, case-insensitive one).
- Each connector ships an opt-in live test (read-only actions) so anyone with an account can verify it.

## Alternatives considered
- **Generate from OpenAPI** (offered; maintainer chose hand-writing). Faster to scale, but the public directory is incomplete for popular SaaS (several major ones are absent), most specs declare no license, and generated action lists are not curated for agents.
- **Count everything as a connector with no tiers.** Rejected: it hides which ones have been proven.

## Trade-offs
Hand-writing is slower and depends on the writer reading documentation correctly; the tiers and tests contain that risk but cannot remove it. One package ships all connectors (ADR-012); revisit when the install size matters.

## When we may revisit
At about 60 connectors: measure tarball size and test time, and reconsider generation for the long tail or splitting packages.
