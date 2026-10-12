# ADR-023: Twilio as three connectors, and next-page links that are paths

- Status: accepted
- Date: 2026-10-12

## Problem
Twilio is a family of products on different hosts (`api.twilio.com`, `verify.twilio.com`, `lookups.twilio.com`, and more), each with its own OpenAPI description. Its core API pages with a RELATIVE link (`next_page_uri: "/2010-04-01/Accounts/AC.../Messages.json?Page=1&PageToken=..."`), where the other Twilio APIs and every strategy so far use an absolute URL.

## Alternatives considered
- One `twilio` connector for every product. Rejected for the reason in ADR-022: one base URL per connector, and a model should not see hundreds of unrelated tools.
- Strip the path in the connector and rebuild the URL there. Rejected: every Twilio list would repeat it; one option on the existing strategy is enough.

## Decision
- Three connectors: `twilio` (the core REST API: messages, calls, numbers, usage, recordings, conferences), `twilio-verify` (one-time codes) and `twilio-lookups` (phone number checks). Messaging services, Conversations, Studio, TaskRouter and others can follow the same way.
- `bodyLinkPagination({ relative: true })` resolves the link against the request's own origin. A link that would change the host (`//evil.example/x`) is refused by the base-URL check before anything is sent, on the way out of a response and on the way in from a caller's cursor.
- The generator takes `idSplit`, a regular expression over the operation id that yields the verb and the resource (`CreateMessage` becomes `message.create`), and names a query parameter such as `DateSent<` `DateSent_before`.
- Bodies are `form-repeat` (ADR-019): a list is sent as a repeated key, which is what Twilio's `MediaUrl` expects.
- The credential is `<AccountSid>:<AuthToken>` with Basic auth. The account SID is also part of the path, so it is an input of each action; the typed actions check its shape.

## Why
It reuses ADR-018, ADR-019 and ADR-022 and adds one option and one generator rule, both off by default.

## Trade-offs
`AccountSid` has to be passed on every core call. The kit cannot yet fill a path parameter from the credential.

## When we may revisit
If more providers put the account id in the path (Twilio, Plivo), let a connector derive it from the credential.
