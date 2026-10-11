# ADR-017: Base-URL variables and HTTP Basic auth

- Status: accepted
- Date: 2026-10-11

## Problem
Many SaaS APIs live at an address that depends on the account: `https://acme.zendesk.com`, `https://acme.atlassian.net`, `https://us19.api.mailchimp.com`, `https://api.datadoghq.eu`. Several of the same providers authenticate with HTTP Basic (`email:api_token`). A connector must express both. The first is also the riskiest feature in the library: **a value that becomes part of the host decides which server receives the credential.**

## Decision
**Variables.** A connector's `baseUrl` may contain `{placeholders}` in its **host** only, each declared in `variables` with a description, an example, and either a `pattern` or a closed list of `values`. The HOST application passes the values when it connects (`connect(connector, { connectionId, variables: { subdomain: "acme" } })`); they never come from a model. They are filled once, at connect time, and an invalid value is a developer-facing error before any request.

Layers of defence, each separately tested (a mutation of any one fails a test):
1. The value must fully match its pattern (default: one DNS label of letters, digits and inner hyphens) or be one of a declared list. Patterns are anchored.
2. The connector's **fixed domain** after the last placeholder (`.zendesk.com`) must survive: whatever a value contains, the final host must end with it. A connector whose host *ends* in a placeholder (`api.{site}`) is only allowed with a closed list of values.
3. The result must be https, with no userinfo, no port.
4. Pagination links and cursors still must stay under the resolved base URL (ADR-010), so a provider's response cannot redirect the token either.
Conformance enforces the author-side rules (declared, used, host-only, example valid, closed list when needed, no placeholders in OAuth URLs).

**Basic auth.** `auth: { type: "basic" }`. The credential is `username:password`, passed as a token string or `{ username, password }`; the kit Base64-encodes it. Connect fails early if a Basic token has no colon. Providers name the pair differently (Jira `email:api_token`, Zendesk `email/token:api_token`, Twilio `AccountSid:AuthToken`); each connector documents its format. Neither the secret nor its Base64 form may appear in errors (tested).

**MCP command.** `--var name=value` (repeatable) supplies variables; `--list` shows which connectors need which.

## Alternatives considered
- Let the user pass a full base URL. Rejected: that is exactly the credential-exfiltration risk; a fixed suffix is the guard.
- Resolve variables per call. Rejected: a value belongs to a connection, and resolving once makes validation a connect-time error.
- A separate credential type for each Basic variant. Rejected: one string format plus a documented example is enough.

## Trade-offs
Self-managed products on arbitrary hosts (GitLab self-managed, Jira Data Center) cannot be expressed: there is no fixed suffix to anchor to. They need an explicit, separately-reviewed "any host" mode, which is deliberately not built. OAuth URLs cannot contain placeholders yet.

## When we may revisit
When a connector needs an OAuth flow on an account-specific host (Shopify, Zendesk OAuth), or the "any host" mode for self-managed deployments.
