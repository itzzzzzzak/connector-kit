import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import shopify from "./index.js"

const connect = { variables: { shop: "acme-store" }, credentials: { token: "shpat_secret" } }
const h = (respond: Parameters<typeof harness>[1]) => harness(shopify, respond, connect)
const P = "gid://shopify/Product/1"
const O = "gid://shopify/Order/2"
const C = "gid://shopify/Customer/3"
const product = { id: P, title: "Tee", handle: "tee", status: "ACTIVE", tags: ["summer"], variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", sku: "TEE-1", price: "19.00", inventoryQuantity: 4 }] } }
const order = { id: O, name: "#1001", email: "ada@acme.dev", displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "19.00", currencyCode: "USD" } }, lineItems: { nodes: [{ title: "Tee", quantity: 1, sku: "TEE-1" }] } }
const customer = { id: C, displayName: "Ada Lovelace", email: "ada@acme.dev", tags: [], numberOfOrders: "2" }
const page = (field: string, nodes: unknown[], next: string | null = null) => ({ data: { [field]: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } })
const one = (field: string, value: unknown) => ({ data: { [field]: value } })

const std = (c: Omit<Parameters<typeof standardTests>[1], "connect">) => standardTests(shopify, { ...c, connect })
std({ action: "shop.get", input: {}, ok: one("shop", { id: "gid://shopify/Shop/1", name: "Acme", currencyCode: "USD" }) })
std({ action: "locations.list", input: {}, ok: page("locations", [{ id: "gid://shopify/Location/1", name: "Warehouse", isActive: true }]), badInput: { pageSize: "x" } })
std({ action: "products.list", input: { query: "status:active" }, ok: page("products", [product]), badInput: { sortKey: "COLOR" } })
std({ action: "product.get", input: { id: P }, ok: one("product", product), badInput: { id: "123" } })
std({ action: "product.create", input: { title: "Tee", status: "DRAFT" }, ok: one("productCreate", { product, userErrors: [] }), badInput: { title: "" } })
std({ action: "product.update", input: { id: P, title: "Tee 2" }, ok: one("productUpdate", { product, userErrors: [] }), badInput: { id: P, status: "GONE" } })
std({ action: "product.delete", input: { id: P }, ok: one("productDelete", { deletedProductId: P, userErrors: [] }), badInput: { id: "x" } })
std({ action: "orders.list", input: { query: "financial_status:paid" }, ok: page("orders", [order]), badInput: { reverse: "yes" } })
std({ action: "order.get", input: { id: O }, ok: one("order", order), badInput: { id: P } })
std({ action: "order.update", input: { id: O, note: "Gift" }, ok: one("orderUpdate", { order, userErrors: [] }), badInput: { id: O, tags: "vip" } })
std({ action: "customers.list", input: {}, ok: page("customers", [customer]), badInput: { pageSize: "x" } })
std({ action: "customer.get", input: { id: C }, ok: one("customer", customer), badInput: { id: "x" } })
std({ action: "customer.create", input: { email: "ada@acme.dev", firstName: "Ada" }, ok: one("customerCreate", { customer, userErrors: [] }), badInput: { email: "not-an-email" } })
std({ action: "customer.update", input: { id: C, tags: ["vip"] }, ok: one("customerUpdate", { customer, userErrors: [] }), badInput: { id: C, tags: "vip" } })
std({ action: "graphql.query", input: { query: "{ shop { name } }" }, ok: { data: { shop: { name: "Acme" } } }, badInput: { query: 5 } })
std({ action: "graphql.mutate", input: { query: "mutation { tagsAdd(id: \"gid://shopify/Order/2\", tags: [\"a\"]) { userErrors { message } } }" }, ok: { data: { tagsAdd: { userErrors: [] } } }, badInput: { query: "" } })

test("calls go to the shop's versioned GraphQL endpoint with the access token header", async () => {
  const { conn, calls } = h(() => json(one("shop", { id: "gid://shopify/Shop/1", name: "Acme" })))
  await conn.execute("shop.get", {})
  assert.equal(calls[0]!.url.toString(), "https://acme-store.myshopify.com/admin/api/2026-07/graphql.json")
  assert.equal(calls[0]!.header("x-shopify-access-token"), "shpat_secret")
  assert.equal(calls[0]!.header("authorization"), null)
})

test("a shop name cannot point the token at another host", () => {
  for (const shop of ["evil.com/", "acme.evil.com", "a b", ""]) {
    assert.throws(() => harness(shopify, () => json({}), { variables: { shop }, credentials: { token: "t" } }), /not valid/, shop)
  }
})

test("a product list sends the search, sort and page size as variables, and pages with after", async () => {
  const { conn, calls } = h((call) => json((call.body as { variables: { after?: string } }).variables.after ? page("products", [product]) : page("products", [product], "cur2")))
  const first = (await conn.execute("products.list", { query: "vendor:Acme", sortKey: "UPDATED_AT", reverse: true, pageSize: 50 })) as { nextCursor: string | null }
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { query: "vendor:Acme", sortKey: "UPDATED_AT", reverse: true, first: 50 })
  assert.equal(first.nextCursor, "cur2")
  await conn.execute("products.list", { cursor: "cur2" })
  assert.equal((calls[1]!.body as { variables: { after: string } }).variables.after, "cur2")
})

test("a page size above Shopify's 250 is clamped to the strategy's limit", async () => {
  const { conn, calls } = h(() => json(page("products", [])))
  await conn.execute("products.list", { pageSize: 5000 })
  assert.ok(((calls[0]!.body as { variables: { first: number } }).variables.first) <= 250)
})

test("creating a product wraps the fields as the product variable", async () => {
  const { conn, calls } = h(() => json(one("productCreate", { product, userErrors: [] })))
  await conn.execute("product.create", { title: "Tee", vendor: "Acme", tags: ["summer"], status: "DRAFT" })
  assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { product: { title: "Tee", vendor: "Acme", tags: ["summer"], status: "DRAFT" } })
  assert.match((calls[0]!.body as { query: string }).query, /^mutation ProductCreate/)
})

test("a mutation that fails validation (HTTP 200 with userErrors) is an invalid_input error, not a success", async () => {
  const { conn } = h(() => json(one("productCreate", { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] })))
  await assert.rejects(() => conn.execute("product.create", { title: "x" }), (e: unknown) => {
    const err = e as { code?: string; message: string; raw?: { body: string } }
    return err.code === "invalid_input" && !err.message.includes("blank") && String(err.raw?.body).includes("blank")
  })
})

test("throttling and denied access arrive as GraphQL errors and are normalized", async () => {
  const throttled = h(() => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }))
  await assert.rejects(() => throttled.conn.execute("shop.get", {}), (e: unknown) => (e as { code?: string; retryable?: boolean }).code === "rate_limited" && (e as { retryable: boolean }).retryable)
  const denied = h(() => json({ errors: [{ message: "Access denied for orders field", extensions: { code: "ACCESS_DENIED" } }] }))
  await assert.rejects(() => denied.conn.execute("orders.list", {}), (e: unknown) => (e as { code?: string }).code === "forbidden")
})

test("the read-only escape hatch refuses mutations, however they are hidden", async () => {
  const { conn, calls } = h(() => json({ data: {} }))
  for (const query of [
    'mutation { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    '# a comment\nmutation M { tagsAdd(id: "x", tags: ["a"]) { node { id } } }',
    '{ shop { name } } mutation { shopLocaleEnable(locale: "fr") { userErrors { message } } }',
    'query { a(x: "#") } mutation { productDelete(input: {id: "x"}) { deletedProductId } }',
    "subscription { x }",
  ]) {
    await assert.rejects(() => conn.execute("graphql.query", { query }), (e: unknown) => (e as { code?: string }).code === "invalid_input", query)
  }
  assert.equal(calls.length, 0)
  await conn.execute("graphql.query", { query: 'query { products(first: 1, query: "title:mutation") { nodes { id } } } # mutation' })
  assert.equal(calls.length, 1)
})

test("the escape hatches send the document and variables as given and return data", async () => {
  const { conn, calls } = h(() => json({ data: { products: { nodes: [{ id: P }] } } }))
  const result = await conn.execute("graphql.query", { query: "query($n: Int) { products(first: $n) { nodes { id } } }", variables: { n: 1 }, operationName: undefined })
  assert.deepEqual(result, { products: { nodes: [{ id: P }] } })
  assert.deepEqual(calls[0]!.body, { query: "query($n: Int) { products(first: $n) { nodes { id } } }", variables: { n: 1 } })
  const m = h(() => json({ data: { tagsAdd: { userErrors: [{ message: "bad" }] } } }))
  await assert.rejects(() => m.conn.execute("graphql.mutate", { query: "mutation { tagsAdd { userErrors { message } } }" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
  await assert.rejects(() => m.conn.execute("graphql.mutate", { query: "{ shop { name } }" }), (e: unknown) => (e as { code?: string }).code === "invalid_input")
})

test("deleting a product and the mutation escape hatch are destructive; reads are reads", () => {
  const effects = Object.fromEntries(Object.entries(shopify.actions).map(([name, a]) => [name, a.effect]))
  assert.equal(effects["product.delete"], "destructive")
  assert.equal(effects["graphql.mutate"], "destructive")
  assert.equal(effects["graphql.query"], "read")
  assert.equal(effects["order.update"], "write")
})
