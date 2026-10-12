import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { checkConnector, defineConnector, detectGraphqlError, graphqlAction, ConnectorKitError } from "./index.js"
import { harness, json } from "./connector-harness.test.js"

const issues = defineConnector({
  name: "tracker",
  baseUrl: "https://api.tracker.test",
  auth: { type: "oauth2", authorizeUrl: "https://tracker.test/authorize", tokenUrl: "https://api.tracker.test/token", rawTokenPattern: "^key_" },
  detectError: (body) => detectGraphqlError(body),
  detectHttpError: ({ status, body }) => {
    const code = (body as { errors?: { extensions?: { code?: string } }[] } | undefined)?.errors?.[0]?.extensions?.code
    return status === 400 && code === "RATELIMITED" ? new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", { retryable: true, status }) : undefined
  },
  actions: {
    "issue.get": graphqlAction({
      description: "Get one issue by its id, with its title.",
      query: "query Issue($id: String!) { issue(id: $id) { id title } }",
      field: "issue",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), title: z.string() }),
      effect: "read",
    }),
    "issues.list": graphqlAction({
      description: "List issues, newest first, one page at a time.",
      query: "query Issues($first: Int, $after: String, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter) { nodes { id } pageInfo { hasNextPage endCursor } } }",
      field: "issues",
      connection: ["issues"],
      input: z.object({ filter: z.record(z.string(), z.unknown()).optional(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(z.object({ id: z.string() })),
      effect: "read",
    }),
  },
})

test("graphql: the body is the query plus the input as variables, and the result is data.<field>", async () => {
  const { conn, calls } = harness(issues, () => json({ data: { issue: { id: "i1", title: "Bug" } } }))
  assert.deepEqual(await conn.execute("issue.get", { id: "i1" }), { id: "i1", title: "Bug" })
  assert.equal(calls[0]!.init.method, "POST")
  assert.equal(calls[0]!.url.pathname, "/graphql")
  assert.deepEqual(calls[0]!.body, { query: "query Issue($id: String!) { issue(id: $id) { id title } }", variables: { id: "i1" } })
})

test("graphql: Relay paging sends first and after as variables and reads pageInfo", async () => {
  const { conn, calls } = harness(issues, () => json({ data: { issues: { nodes: [{ id: "a" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }))
  const first = (await conn.execute("issues.list", { filter: { priority: { eq: 1 } } })) as { items: unknown[]; nextCursor: string | null }
  assert.deepEqual(first, { items: [{ id: "a" }], nextCursor: "c1" })
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { filter: { priority: { eq: 1 } }, first: 25 })
  await conn.execute("issues.list", { cursor: "c1", pageSize: 10 })
  assert.deepEqual((calls[1]!.body as { variables: unknown }).variables, { first: 10, after: "c1" })
})

test("graphql: the last page has no next cursor", async () => {
  const { conn } = harness(issues, () => json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "zz" } } } }))
  const page = (await conn.execute("issues.list", {})) as { nextCursor: string | null }
  assert.equal(page.nextCursor, null)
})

test("graphql: errors in a 200 response become normalized errors, with the provider text kept out of the message", async () => {
  const cases: [string, string][] = [
    ["AUTHENTICATION_ERROR", "auth_expired"],
    ["FORBIDDEN", "forbidden"],
    ["RATELIMITED", "rate_limited"],
    ["INVALID_INPUT", "invalid_input"],
    ["SOMETHING_ELSE", "upstream_error"],
  ]
  for (const [code, expected] of cases) {
    const { conn } = harness(issues, () => json({ errors: [{ message: "secret detail", extensions: { code } }], data: null }))
    await assert.rejects(() => conn.execute("issue.get", { id: "x" }), (e: unknown) => {
      const err = e as ConnectorKitError
      return err.code === expected && !err.message.includes("secret detail") && String(err.raw?.body).includes("secret detail")
    })
  }
})

test("graphql: a rate limit that arrives as HTTP 400 is mapped by detectHttpError", async () => {
  const { conn } = harness(issues, () => json({ errors: [{ extensions: { code: "RATELIMITED" } }] }, 400))
  await assert.rejects(() => conn.execute("issue.get", { id: "x" }), (e: unknown) => (e as ConnectorKitError).code === "rate_limited")
})

test("graphql: a token matching rawTokenPattern is sent without Bearer, any other with it", async () => {
  const raw = harness(issues, () => json({ data: { issue: { id: "1", title: "t" } } }), { credentials: { token: "key_abc" } })
  await raw.conn.execute("issue.get", { id: "1" })
  assert.equal(raw.calls[0]!.header("authorization"), "key_abc")
  const bearer = harness(issues, () => json({ data: { issue: { id: "1", title: "t" } } }), { credentials: { token: "oauth_abc" } })
  await bearer.conn.execute("issue.get", { id: "1" })
  assert.equal(bearer.calls[0]!.header("authorization"), "Bearer oauth_abc")
})

test("graphql: the connector passes the conformance check", () => {
  assert.deepEqual(checkConnector(issues, { requireMeta: false }), [])
})
