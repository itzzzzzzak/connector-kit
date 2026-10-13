# ADR-028: One header built from several credential values, and the Trello connector

- Status: accepted
- Date: 2026-10-13

## Problem
Trello authenticates with two secrets, an API key and a user token, sent either as query parameters or in one header: `Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"`. The kit's `apiKeys` type (ADR-025) sends each value in its own header, and no type builds a single header from several values.

## Alternatives considered
- Query parameters (`key=...&token=...`). Rejected: secrets in URLs end up in logs, proxies and error text.
- Let the model or each action assemble the header. Rejected: the secret would pass through the model's input.

## Decision
- New auth type `{ type: "headerTemplate", header, template }`. The credential is the values joined by ":", for example `KEY:TOKEN`. Slots `{1}`, `{2}`, ... in the template are filled in order.
- Each value must match `[A-Za-z0-9._~+-]+`, so a value cannot add quotes, line breaks or spaces to the header. A wrong number of values is refused before any request.
- Conformance checks the header name, that the slots run `{1}..{n}` with no gaps, and that the template has no line breaks. `connect()` checks the value count.
- The secret never appears in errors, as with the other types.
- Trello: 14 hand-written actions. Archiving a card is destructive but reversible; deleting is destructive and permanent. Commenting and creating cards notify board members, so their descriptions say to ask a human first.

## Trade-offs
Values cannot contain ":" or other punctuation. Trello keys and tokens are hex or alphanumeric, so this fits.

## When we may revisit
A provider whose secrets need characters outside that set.
