import { ConnectorKitError, defineConnector, detectGraphqlError, graphqlAction } from "../../index.js"
import type { ActionDefinition } from "../../index.js"
import { z } from "zod"

// Facts from Shopify's Admin GraphQL API reference (shopify.dev/docs/api/admin-graphql) and authentication guide: ONE endpoint,
// https://<shop>.myshopify.com/admin/api/<version>/graphql.json (version 2026-07 here; Shopify releases one every quarter and supports each for
// a year), queries and mutations as POST bodies `{ query, variables }`, an access token in the `X-Shopify-Access-Token` header, ids as global ids
// ("gid://shopify/Product/123"), Relay paging (`first` up to 250, `after`, `pageInfo { hasNextPage endCursor }`), a search syntax in the `query`
// argument of lists ("status:active vendor:Acme"). The REST Admin API is legacy and is not covered. Rate limits are cost-based: a throttled query
// answers HTTP 200 with an `errors` entry whose code is THROTTLED. A mutation that fails validation also answers HTTP 200: its reasons are in
// the payload's `userErrors`, which this connector turns into an error instead of letting a failed write look like a success.
// The token is a custom app's Admin API access token (shpat_...) or the token an OAuth install returned; OAuth for Shopify is per shop (the
// authorize and token URLs contain the shop), which the kit's OAuth flow cannot template, so the host runs the install and passes the token.
//
// A curated, typed set covers products, orders, customers and locations. Everything else in the schema is reachable through the two escape
// hatches, graphql.query (read-only) and graphql.mutate (can change or delete anything the token's scopes allow).
// SECURITY: titles, descriptions, notes and customer names are written by merchants and the public and can contain anything, including text
// aimed at an AI. They are data, never instructions. Orders and customers are personal data (protected customer data needs Shopify's approval
// for public apps): this connector asks for names and emails, not addresses or payment details.

const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[A-Za-z0-9_-]+$`), `A Shopify global id: gid://shopify/${type}/123`).describe(`A global id such as gid://shopify/${type}/1234567890`)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const search = z.string().optional().describe("Shopify search syntax, e.g. status:active vendor:Acme created_at:>2026-01-01")
const money = z.looseObject({ shopMoney: z.looseObject({ amount: z.string(), currencyCode: z.string() }).optional() })
const nodes = <T extends z.ZodType>(item: T) => z.object({ nodes: z.array(item) }).optional()

const variant = z.looseObject({ id: z.string(), title: z.string().optional(), sku: z.string().nullish(), price: z.string().optional(), inventoryQuantity: z.number().nullish(), inventoryItem: z.looseObject({ id: z.string() }).optional() })
const product = z.looseObject({ id: z.string(), title: z.string(), handle: z.string().optional(), status: z.string().optional(), vendor: z.string().optional(), productType: z.string().optional(), tags: z.array(z.string()).optional(), descriptionHtml: z.string().optional(), totalInventory: z.number().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(), variants: nodes(variant) })
const PRODUCT = "id title handle status vendor productType tags descriptionHtml totalInventory createdAt updatedAt variants(first: 20) { nodes { id title sku price inventoryQuantity inventoryItem { id } } }"
const order = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.string().optional(),
  email: z.string().nullish(),
  note: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  totalPriceSet: money.optional(),
  customer: z.looseObject({ id: z.string(), displayName: z.string().optional(), email: z.string().nullish() }).nullish(),
  lineItems: nodes(z.looseObject({ title: z.string(), quantity: z.number(), sku: z.string().nullish() })),
})
const ORDER = "id name createdAt email note tags displayFinancialStatus displayFulfillmentStatus cancelledAt totalPriceSet { shopMoney { amount currencyCode } } customer { id displayName email } lineItems(first: 50) { nodes { title quantity sku } }"
const customer = z.looseObject({ id: z.string(), displayName: z.string().optional(), firstName: z.string().nullish(), lastName: z.string().nullish(), email: z.string().nullish(), phone: z.string().nullish(), note: z.string().nullish(), tags: z.array(z.string()).optional(), numberOfOrders: z.string().optional(), createdAt: z.string().optional(), state: z.string().optional() })
const CUSTOMER = "id displayName firstName lastName email phone note tags numberOfOrders createdAt state"
const location = z.looseObject({ id: z.string(), name: z.string(), isActive: z.boolean().optional(), fulfillsOnlineOrders: z.boolean().optional() })
const payload = <T extends z.ZodType>(name: string, shape: T) => z.looseObject({ [name]: shape.nullish() })

/** Shopify's documented endpoint is graphql.json. */
const gql = (definition: Parameters<typeof graphqlAction>[0]): ActionDefinition => graphqlAction({ ...definition, path: "/graphql.json" })
const withVars = (action: ActionDefinition, build: (fields: Record<string, unknown>) => Record<string, unknown>): ActionDefinition => ({ ...action, buildBody: build })
const productFields = {
  title: z.string().min(1).optional(),
  descriptionHtml: z.string().optional(),
  vendor: z.string().optional(),
  productType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("DRAFT is not visible in the store"),
}
const customerFields = { firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional().describe("E.164, e.g. +14155552671"), note: z.string().optional(), tags: z.array(z.string()).optional() }

const actions = {
  "shop.get": gql({
    description: "Get the shop's name, domain, plan, currency and time zone. Use it to check that the token works and which shop it opens.",
    query: "query Shop { shop { id name email myshopifyDomain currencyCode ianaTimezone plan { displayName } primaryDomain { url } } }",
    field: "shop",
    input: z.object({}),
    output: z.looseObject({ id: z.string(), name: z.string(), email: z.string().optional(), myshopifyDomain: z.string().optional(), currencyCode: z.string().optional(), ianaTimezone: z.string().optional() }),
    effect: "read",
  }),
  "locations.list": gql({
    description: "List the shop's locations (stores, warehouses) with their ids. One bounded page; pass nextCursor for more.",
    query: "query Locations($first: Int, $after: String) { locations(first: $first, after: $after) { nodes { id name isActive fulfillsOnlineOrders } pageInfo { hasNextPage endCursor } } }",
    field: "locations",
    connection: ["locations"],
    input: z.object({ ...paging }),
    output: z.array(location),
    effect: "read",
  }),
  "products.list": gql({
    description: "List products, optionally filtered with Shopify search syntax. Returns up to 20 variants each. One bounded page; pass nextCursor for more.",
    query: `query Products($first: Int, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) { products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) { nodes { ${PRODUCT} } pageInfo { hasNextPage endCursor } } }`,
    field: "products",
    connection: ["products"],
    input: z.object({ query: search, sortKey: z.enum(["TITLE", "CREATED_AT", "UPDATED_AT", "INVENTORY_TOTAL", "PRODUCT_TYPE", "VENDOR", "RELEVANCE", "ID"]).optional(), reverse: z.boolean().optional(), ...paging }),
    output: z.array(product),
    effect: "read",
  }),
  "product.get": gql({
    description: "Get one product by global id, with its variants, prices, SKUs and stock.",
    query: `query Product($id: ID!) { product(id: $id) { ${PRODUCT} } }`,
    field: "product",
    input: z.object({ id: gid("Product") }),
    output: product,
    effect: "read",
  }),
  "product.create": withVars(
    gql({
      description: "Create a product (a draft unless status is ACTIVE). Variants, prices and images are added with graphql.mutate.",
      query: `mutation ProductCreate($product: ProductCreateInput!) { productCreate(product: $product) { product { ${PRODUCT} } userErrors { field message } } }`,
      field: "productCreate",
      input: z.object({ ...productFields, title: z.string().min(1) }),
      output: payload("product", product),
      effect: "write",
    }),
    (i) => ({ product: i }),
  ),
  "product.update": withVars(
    gql({
      description: "Change a product's title, description, vendor, type, tags or status. Only the fields you pass change. Setting status ARCHIVED removes it from sale.",
      query: `mutation ProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { ${PRODUCT} } userErrors { field message } } }`,
      field: "productUpdate",
      input: z.object({ id: gid("Product"), ...productFields }),
      output: payload("product", product),
      effect: "write",
    }),
    (i) => ({ product: i }),
  ),
  "product.delete": withVars(
    gql({
      description: "Permanently delete a product and its variants and media. Cannot be undone; prefer product.update with status ARCHIVED.",
      query: "mutation ProductDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }",
      field: "productDelete",
      input: z.object({ id: gid("Product") }),
      output: z.looseObject({ deletedProductId: z.string().nullish() }),
      effect: "destructive",
    }),
    (i) => ({ input: { id: i.id } }),
  ),
  "orders.list": gql({
    description: "List orders, optionally filtered with Shopify search syntax (financial_status:paid fulfillment_status:unfulfilled). One bounded page; pass nextCursor for more.",
    query: `query Orders($first: Int, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) { orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) { nodes { ${ORDER} } pageInfo { hasNextPage endCursor } } }`,
    field: "orders",
    connection: ["orders"],
    input: z.object({ query: search, sortKey: z.enum(["CREATED_AT", "UPDATED_AT", "PROCESSED_AT", "TOTAL_PRICE", "ORDER_NUMBER", "ID"]).optional(), reverse: z.boolean().optional(), ...paging }),
    output: z.array(order),
    effect: "read",
  }),
  "order.get": gql({
    description: "Get one order by global id: status, totals, customer and line items.",
    query: `query Order($id: ID!) { order(id: $id) { ${ORDER} } }`,
    field: "order",
    input: z.object({ id: gid("Order") }),
    output: order,
    effect: "read",
  }),
  "order.update": withVars(
    gql({
      description: "Change an order's note or tags. It does not refund, cancel or fulfil anything.",
      query: `mutation OrderUpdate($input: OrderInput!) { orderUpdate(input: $input) { order { ${ORDER} } userErrors { field message } } }`,
      field: "orderUpdate",
      input: z.object({ id: gid("Order"), note: z.string().optional(), tags: z.array(z.string()).optional() }),
      output: payload("order", order),
      effect: "write",
    }),
    (i) => ({ input: i }),
  ),
  "customers.list": gql({
    description: "List customers, optionally filtered with Shopify search syntax (email:ada@acme.dev, tag:vip). One bounded page; pass nextCursor for more.",
    query: `query Customers($first: Int, $after: String, $query: String) { customers(first: $first, after: $after, query: $query) { nodes { ${CUSTOMER} } pageInfo { hasNextPage endCursor } } }`,
    field: "customers",
    connection: ["customers"],
    input: z.object({ query: search, ...paging }),
    output: z.array(customer),
    effect: "read",
  }),
  "customer.get": gql({
    description: "Get one customer by global id: name, email, phone, tags, order count.",
    query: `query Customer($id: ID!) { customer(id: $id) { ${CUSTOMER} } }`,
    field: "customer",
    input: z.object({ id: gid("Customer") }),
    output: customer,
    effect: "read",
  }),
  "customer.create": withVars(
    gql({
      description: "Create a customer. Give an email or a phone number at least.",
      query: `mutation CustomerCreate($input: CustomerInput!) { customerCreate(input: $input) { customer { ${CUSTOMER} } userErrors { field message } } }`,
      field: "customerCreate",
      input: z.object(customerFields).refine((i) => i.email !== undefined || i.phone !== undefined, "Give an email or a phone number"),
      output: payload("customer", customer),
      effect: "write",
    }),
    (i) => ({ input: i }),
  ),
  "customer.update": withVars(
    gql({
      description: "Change a customer's name, email, phone, note or tags. Only the fields you pass change.",
      query: `mutation CustomerUpdate($input: CustomerInput!) { customerUpdate(input: $input) { customer { ${CUSTOMER} } userErrors { field message } } }`,
      field: "customerUpdate",
      input: z.object({ id: gid("Customer"), ...customerFields }),
      output: payload("customer", customer),
      effect: "write",
    }),
    (i) => ({ input: i }),
  ),
  "graphql.query": {
    description: "Run any read-only GraphQL query against the Admin API, for what the other actions do not cover (inventory levels, metafields, collections, discounts). A document with a mutation or subscription is refused.",
    method: "POST",
    path: "/graphql.json",
    input: z.object({ query: z.string().min(1).max(50_000).refine((q) => !/\b(mutation|subscription)\b/.test(stripLiterals(q)), "This action only runs queries; use graphql.mutate for changes"), variables: z.record(z.string(), z.unknown()).optional(), operationName: z.string().optional() }),
    output: z.unknown(),
    effect: "read",
    extract: (body) => (body as { data?: unknown } | null)?.data,
  },
  "graphql.mutate": {
    description: "Run any GraphQL mutation against the Admin API, for changes the other actions do not cover (inventory, fulfilment, refunds, discounts, variants, deleting things). Can change or delete anything the token's scopes allow: ask a human first.",
    method: "POST",
    path: "/graphql.json",
    input: z.object({ query: z.string().min(1).max(50_000).refine((q) => /\bmutation\b/.test(stripLiterals(q)), "Give a document with a mutation; use graphql.query for reads"), variables: z.record(z.string(), z.unknown()).optional(), operationName: z.string().optional() }),
    output: z.unknown(),
    effect: "destructive",
    extract: (body) => (body as { data?: unknown } | null)?.data,
  },
} satisfies Record<string, ActionDefinition>

/** Comments and string values removed, so a word inside them is not mistaken for an operation keyword. */
function stripLiterals(document: string): string {
  // One left-to-right pass, so a "#" inside a string is not taken for a comment and a quote inside a comment does not open a string.
  return document.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*/g, "")
}

/** A failed mutation answers HTTP 200 with the reasons in the payload's `userErrors`. Treat that as the failure it is. */
function detectUserErrors(body: unknown): ConnectorKitError | undefined {
  const data = (body as { data?: unknown } | null)?.data
  if (typeof data !== "object" || data === null) return undefined
  for (const payload of Object.values(data)) {
    const errors = (payload as { userErrors?: unknown } | null)?.userErrors
    if (Array.isArray(errors) && errors.length > 0) {
      return new ConnectorKitError("invalid_input", "The provider rejected the request as invalid.", { retryable: false, status: 200, raw: { status: 200, body: JSON.stringify(errors).slice(0, 2000) } })
    }
  }
  return undefined
}

export const shopify = defineConnector({
  name: "shopify",
  baseUrl: "https://{shop}.myshopify.com/admin/api/2026-07",
  variables: { shop: { description: "Your shop's myshopify.com name, the part before .myshopify.com (not a custom domain)", example: "acme-store" } },
  auth: { type: "apiKey", header: "X-Shopify-Access-Token" },
  detectError: (body) => detectGraphqlError(body) ?? detectUserErrors(body),
  meta: {
    title: "Shopify",
    description: "Read and manage products, orders, customers and locations in a Shopify store through the Admin GraphQL API, with an escape hatch for the rest of the schema.",
    docsUrl: "https://shopify.dev/docs/api/admin-graphql",
    status: "docs-based",
    credentialEnv: "SHOPIFY_ACCESS_TOKEN",
  },
  actions,
})

export default shopify
