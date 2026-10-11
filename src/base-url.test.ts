import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { resolveBaseUrl } from "./base-url.js"
import { checkConnector, defineConnector, type ConnectorVariable } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const sub: Record<string, ConnectorVariable> = { subdomain: { description: "Your Zendesk subdomain", example: "acme" } }
const T = "https://{subdomain}.zendesk.com/api/v2"
const resolve = (given?: Record<string, string>, template = T, declared = sub) => resolveBaseUrl("zendesk", template, declared, given)

// ------------------------------------------------------------- the happy path

test("a valid subdomain fills the template", () => {
  assert.equal(resolve({ subdomain: "acme" }), "https://acme.zendesk.com/api/v2")
  assert.equal(resolve({ subdomain: "My-Co-2" }), "https://My-Co-2.zendesk.com/api/v2")
})

test("a template without placeholders is returned as is, and refuses stray variables", () => {
  assert.equal(resolveBaseUrl("x", "https://api.x.dev/v1", undefined, undefined), "https://api.x.dev/v1")
  assert.throws(() => resolveBaseUrl("x", "https://api.x.dev/v1", undefined, { oops: "1" }), /takes no variables/)
})

// ------------------------------------------------------------- the attacks: a value must not change WHERE we send the token

test("values that would redirect the credential to another server are all rejected", () => {
  const hostile = [
    "evil.com/x", "evil.com", "a.b", "a/b", "a\\b", "a@evil.com", "evil.com#", "a?x=1", "a:443", "a b", "a\nb", "a%2eevil", "",
    "-a", "a-", "x".repeat(64), "a.evil.com", "..", "http://evil.com", "a;b", "a,b",
  ]
  for (const value of hostile) assert.throws(() => resolve({ subdomain: value }), /not valid/, JSON.stringify(value))
})

test("non-string values are rejected", () => {
  for (const value of [5, null, undefined, {}, ["acme"]]) assert.throws(() => resolve({ subdomain: value as never }), /not valid|needs variables/)
})

test("whatever is accepted, the host always stays under the template's fixed domain", () => {
  for (const value of ["acme", "a", "a1", "my-company", "A-B-C-1-2"]) {
    const url = new URL(resolve({ subdomain: value }))
    assert.ok(url.hostname.endsWith(".zendesk.com"), url.hostname)
    assert.equal(url.protocol, "https:")
    assert.equal(url.username + url.password + url.port, "")
  }
})

// ------------------------------------------------------------- defense in depth: a SLOPPY pattern must still not redirect the token

test("even a connector author's permissive pattern (.+) cannot change the domain, add userinfo or a port", () => {
  const sloppy: Record<string, ConnectorVariable> = { subdomain: { description: "Anything at all", example: "acme", pattern: ".+" } }
  for (const value of ["evil.com/x#", "evil.com?", "evil.com\\", "a@evil.com", "a:b@evil.com", "x:8080", "evil.com:443/", "e.com#"]) {
    assert.throws(() => resolve({ subdomain: value }, T, sloppy), /change the domain|not plain https|Invalid URL/, JSON.stringify(value))
  }
  // and a harmless value is still fine
  assert.equal(resolve({ subdomain: "acme" }, T, sloppy), "https://acme.zendesk.com/api/v2")
})

// ------------------------------------------------------------- configuration mistakes explain themselves

test("a missing variable says what to pass, with its description and example", () => {
  assert.throws(() => resolve({}), /needs variables: subdomain \(Your Zendesk subdomain, e\.g\. "acme"\)/)
  assert.throws(() => resolve(undefined), /needs variables/)
})

test("an unknown variable name (a typo) is rejected", () => {
  assert.throws(() => resolve({ subdomain: "acme", sub: "x" }), /no variable named sub/)
})

test("a placeholder that was never declared is a clear error", () => {
  assert.throws(() => resolve({ subdomain: "acme" }, T, {}), /does not declare it/)
})

test("the error shows only a short, JSON-quoted piece of a bad value", () => {
  try {
    resolve({ subdomain: "x".repeat(500) + "/evil" })
    assert.fail("should throw")
  } catch (e) {
    assert.ok((e as Error).message.length < 400)
  }
})

// ------------------------------------------------------------- patterns and closed lists

test("a closed list of values (regions) is enforced exactly, and may fill a host that ends with the placeholder", () => {
  const regions: Record<string, ConnectorVariable> = { site: { description: "Datadog site", example: "datadoghq.com", values: ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com"] } }
  const t = "https://api.{site}"
  assert.equal(resolveBaseUrl("dd", t, regions, { site: "datadoghq.eu" }), "https://api.datadoghq.eu")
  for (const bad of ["datadoghq.com.evil.net", "evil.com", "DATADOGHQ.COM", "datadoghq.com/", " datadoghq.com"]) {
    assert.throws(() => resolveBaseUrl("dd", t, regions, { site: bad }), /one of: datadoghq\.com/, JSON.stringify(bad))
  }
})

test("a custom pattern may allow dots (Salesforce my-domain hosts) but is still fully anchored", () => {
  const sf: Record<string, ConnectorVariable> = { instance: { description: "My Domain", example: "acme", pattern: "[A-Za-z0-9](?:[A-Za-z0-9.-]{0,100}[A-Za-z0-9])?" } }
  const t = "https://{instance}.my.salesforce.com/services/data"
  assert.equal(resolveBaseUrl("sf", t, sf, { instance: "acme.sandbox" }), "https://acme.sandbox.my.salesforce.com/services/data")
  assert.throws(() => resolveBaseUrl("sf", t, sf, { instance: "acme/evil" }), /not valid/)
  assert.throws(() => resolveBaseUrl("sf", t, sf, { instance: "acme.my.salesforce.com@evil.com" }), /not valid/)
})

test("two variables in one host are both validated", () => {
  const two: Record<string, ConnectorVariable> = { dc: { description: "Data center", example: "us19" }, region: { description: "Region", example: "eu" } }
  assert.equal(resolveBaseUrl("x", "https://{dc}.{region}.api.x.com/3.0", two, { dc: "us19", region: "eu" }), "https://us19.eu.api.x.com/3.0")
  assert.throws(() => resolveBaseUrl("x", "https://{dc}.{region}.api.x.com/3.0", two, { dc: "us19", region: "e/u" }), /"region"/)
})

// ------------------------------------------------------------- end to end through the kit

const acme = defineConnector({
  name: "acme",
  baseUrl: "https://{subdomain}.acme.dev/api/v2",
  variables: { subdomain: { description: "Your Acme subdomain", example: "company" } },
  auth: { type: "bearer" },
  actions: { "things.get": { description: "Get a thing by id. Use when the user asks about one thing.", method: "GET", path: "/things/{id}", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), effect: "read" } },
})

test("kit.connect fills the host per connection: two tenants, two hosts, and no cross-talk", async () => {
  const seen: string[] = []
  const { kit } = harness(acme, (c) => (seen.push(`${c.url.host} ${c.header("authorization")}`), json({ id: "1" })), { variables: { subdomain: "seed" } })
  const alpha = kit.connect(acme, { connectionId: "a", credentials: { token: "alpha-token" }, variables: { subdomain: "alpha" } })
  const beta = kit.connect(acme, { connectionId: "b", credentials: { token: "beta-token" }, variables: { subdomain: "beta" } })
  await alpha.execute("things.get", { id: "1" })
  await beta.execute("things.get", { id: "1" })
  assert.deepEqual(seen, ["alpha.acme.dev Bearer alpha-token", "beta.acme.dev Bearer beta-token"])
})

test("connecting without the variable, or with a hostile one, fails before any request", () => {
  const { kit, calls } = harness(acme, () => json({ id: "1" }), { variables: { subdomain: "seed" } })
  calls.length = 0 // the harness itself connected once; we care about what happens next
  assert.throws(() => kit.connect(acme, { connectionId: "a", credentials: { token: "t" } }), /needs variables: subdomain/)
  assert.throws(() => kit.connect(acme, { connectionId: "a", credentials: { token: "t" }, variables: { subdomain: "evil.com/x" } }), /not valid/)
  assert.equal(calls.length, 0)
})

test("a next-page link that points at a different host is still refused when the host came from a variable", async () => {
  const paged = defineConnector({
    name: "paged",
    baseUrl: "https://{subdomain}.paged.dev/api",
    variables: { subdomain: { description: "Subdomain", example: "company" } },
    auth: { type: "bearer" },
    actions: {
      "items.list": {
        description: "List items; the body carries the next page's full URL.",
        method: "GET",
        path: "/items",
        input: z.object({ cursor: z.string().optional(), pageSize: z.number().optional() }),
        output: z.array(z.object({ id: z.string() })),
        effect: "read",
        paginate: { pageSizeParam: "per_page", defaultPageSize: 30, maxPageSize: 100, items: (b) => (b as { items: unknown }).items, nextCursor: ({ body }) => (body as { next?: string }).next ?? null, applyCursor: (_u, c) => new URL(c) },
      },
    },
  })
  const { kit } = harness(paged, () => json({ items: [], next: "https://other.paged.dev/api/items?page=2" }), { variables: { subdomain: "seed" } })
  const conn = kit.connect(paged, { connectionId: "c", credentials: { token: "t" }, variables: { subdomain: "mine" } })
  await assert.rejects(() => conn.execute("items.list", {}), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

// ------------------------------------------------------------- the conformance rules around variables

const base = { name: "acme", auth: { type: "bearer" }, meta: { title: "Acme", description: "Does acme things for agents.", docsUrl: "https://acme.dev/docs", status: "docs-based", credentialEnv: "ACME_TOKEN" }, actions: { "things.get": acme.actions["things.get"] } }
const problems = (over: Record<string, unknown>) => checkConnector({ ...base, baseUrl: "https://api.acme.dev/v1", ...over } as never).join(" | ")

test("conformance: placeholders must be declared, and declared variables must be used", () => {
  assert.match(problems({ baseUrl: "https://{sub}.acme.dev/v1" }), /does not declare it/)
  assert.match(problems({ variables: { sub: { description: "x ok", example: "a" } } }), /declared but not used/)
})

test("conformance: placeholders are only allowed in the host, never the path", () => {
  assert.match(problems({ baseUrl: "https://{sub}.acme.dev/{ver}", variables: { sub: sub.subdomain, ver: { description: "Version", example: "v1" } } }), /only allowed in the host/)
})

test("conformance: a host that ends in a placeholder needs a closed list of values", () => {
  assert.match(problems({ baseUrl: "https://api.{site}", variables: { site: { description: "Site", example: "a" } } }), /closed list/)
  assert.equal(problems({ baseUrl: "https://api.{site}", variables: { site: { description: "Site", example: "datadoghq.com", values: ["datadoghq.com", "datadoghq.eu"] } } }), "")
})

test("conformance: the fixed domain after the placeholder must look like a domain", () => {
  assert.match(problems({ baseUrl: "https://{sub}-x", variables: { sub: sub.subdomain } }), /fixed domain/)
})

test("conformance: an example that fails its own rule, a bad pattern and an empty list are caught", () => {
  assert.match(problems({ baseUrl: "https://{sub}.acme.dev/v1", variables: { sub: { description: "Subdomain here", example: "a.b" } } }), /does not satisfy/)
  assert.match(problems({ baseUrl: "https://{sub}.acme.dev/v1", variables: { sub: { description: "Subdomain here", example: "a", pattern: "[" } } }), /not a valid regular expression/)
  assert.match(problems({ baseUrl: "https://{sub}.acme.dev/v1", variables: { sub: { description: "Subdomain here", example: "a", values: [] } } }), /must not be empty/)
})

test("conformance: a well-formed variable connector passes, and OAuth URLs cannot contain placeholders", () => {
  assert.equal(problems({ baseUrl: "https://{subdomain}.acme.dev/api/v2", variables: sub }), "")
  assert.match(problems({ baseUrl: "https://{subdomain}.acme.dev/api/v2", variables: sub, auth: { type: "oauth2", authorizeUrl: "https://{subdomain}.acme.dev/a", tokenUrl: "https://acme.dev/t" } }), /cannot contain \{placeholders\}/)
})
