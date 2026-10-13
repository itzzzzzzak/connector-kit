# ADR-027: A token in the URL path, and the Telegram connector

- Status: accepted
- Date: 2026-10-13

## Problem
The Telegram Bot API has no auth header. The bot token is part of the path: `https://api.telegram.org/bot<token>/sendMessage`. The kit could place a credential only in a header, and base-URL `{variables}` only in the host, so Telegram could not be reached without a core change.

## Alternatives considered
- A base-URL variable for the token. Rejected: variables are not secrets (ADR-025); they are logged and shown like hostnames, and are limited to the host.
- Let each action build its own path from a token field in the input. Rejected: the model would see and handle the secret, and every action would carry it.

## Decision
- New auth type `{ type: "pathToken", prefix?: "bot" }`. The credential is inserted right after the base path, before the action path, only in the URL passed to `fetch`. `applyAuth` sends no header for it.
- The token is percent-encoded (a ":" is kept, since bot tokens contain one), so it cannot add path segments, a query or a fragment, and the existing "stay under the base URL" check still holds.
- The token never appears in an error (errors are generic and carry no URL), in a pagination cursor (built from the token-free URL) or in a result. Conformance limits `prefix` to 16 letters, digits, `-` and `_`.
- Telegram: 12 hand-written actions, results unwrapped from `{ ok, result }` with `extract`. `getUpdates` always sends `timeout: 0`, so it never holds a request open. Sending is a write; deleting a message, leaving a chat and removing the webhook are destructive.

## Why
It is the smallest change that keeps the secret out of the model's reach and out of the host part of the URL.

## Trade-offs
The token is in the request URL, so a proxy or the provider's access log on the way can see it (the same is true of Telegram's own documented usage). Hosts should keep their own request logging free of URLs for this connector. Long polling is not offered; use a webhook for a live bot.

## When we may revisit
A second provider that needs a credential in the query string or in a different path position.
