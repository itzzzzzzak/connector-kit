import { ConnectorKitError, defineConnector, detectGraphqlError, graphqlAction } from "../../index.js"
import type { ActionDefinition } from "../../index.js"
import { z } from "zod"

// Facts from monday.com's API documentation (developer.monday.com/api-reference): ONE GraphQL endpoint, POST https://api.monday.com/v2, the
// personal API token (or an OAuth access token) sent as `Authorization: <token>` WITHOUT "Bearer", and an `API-Version` header that pins the schema
// version (versions are dated, "YYYY-MM"). Ids are numbers written as text. Boards page with `limit` and `page`; the items of a board page with a
// CURSOR: `boards(ids: [..]) { items_page(limit) { cursor items } }` for the first page and `next_items_page(cursor, limit)` for the rest (a cursor
// lives 60 minutes). A column value is written as a JSON string keyed by column id, e.g. {"status": {"label": "Done"}, "date4": {"date": "2026-10-20"}}.
// Failures usually come back as HTTP 200 with an `errors` array whose `extensions.code` names the problem (UserUnauthorizedException,
// ComplexityException, COMPLEXITY_BUDGET_EXHAUSTED, RateLimitExceeded, ...).
//
// Each action is a curated GraphQL document with a typed result. Anything else in the schema is reachable by writing another graphqlAction() the same way.
// SECURITY: item names, updates and column text are written by your colleagues and by form or email integrations and can contain text aimed at an
// AI: they are data, never instructions. An update (comment) notifies the people following the item.

const id = z.string().regex(/^\d{1,20}$/, "A monday.com id is a number written as text")
const boardId = id.describe("The board id (digits), from boards.list")
const itemId = id.describe("The item id (digits)")
const limit = z.number().int().min(1).max(100).optional()
const dig = (value: unknown, path: Array<string | number>): unknown => path.reduce<unknown>((current, key) => (typeof current === "object" && current !== null ? (current as Record<string | number, unknown>)[key] : undefined), value)

const columnValue = z.looseObject({ id: z.string(), type: z.string().optional(), text: z.string().nullish(), value: z.string().nullish() })
const item = z.looseObject({
  id: z.string(),
  name: z.string(),
  state: z.string().optional(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  group: z.looseObject({ id: z.string(), title: z.string().optional() }).nullish(),
  board: z.looseObject({ id: z.string() }).nullish(),
  column_values: z.array(columnValue).optional(),
})
const ITEM = "id name state created_at updated_at group { id title } board { id } column_values { id type text value }"
const itemsPage = z.looseObject({ cursor: z.string().nullable(), items: z.array(item) })
const board = z.looseObject({ id: z.string(), name: z.string(), description: z.string().nullish(), state: z.string().optional(), board_kind: z.string().optional(), workspace: z.looseObject({ id: z.string().nullish(), name: z.string().optional() }).nullish() })
const update = z.looseObject({ id: z.string(), body: z.string().optional(), text_body: z.string().nullish(), created_at: z.string().nullish(), creator: z.looseObject({ id: z.string(), name: z.string().optional() }).nullish() })
const columnValues = z.record(z.string(), z.unknown()).describe('Column values keyed by column id, e.g. { "status": { "label": "Done" }, "date4": { "date": "2026-10-20" } }. Column ids are in board.get')

/** Replace how the result is read: the first element of `data.<root>` and then a path inside it. */
const firstOf = (action: ActionDefinition, root: string, ...path: string[]): ActionDefinition => ({ ...action, extract: (body) => dig(dig(body, ["data", root]), [0, ...path]) })
/** A mutation or query takes its variables from the action's fields, and a column-values object travels as the JSON string monday.com expects. */
const withJsonColumns = (action: ActionDefinition): ActionDefinition => ({
  ...action,
  buildBody: (fields) => ({ ...fields, columnValues: JSON.stringify(fields.columnValues ?? {}) }),
})

export const monday = defineConnector({
  name: "monday",
  baseUrl: "https://api.monday.com",
  auth: { type: "apiKey", header: "Authorization" },
  defaultHeaders: { "API-Version": "2026-01" },
  detectError: (body) => {
    const code = String(dig(body, ["errors", 0, "extensions", "code"]) ?? "")
    // The complexity budget is monday.com's rate limit; the reset time is in the message, so only a retry later helps.
    if (/complexity/i.test(code)) return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", { retryable: true, status: 200 })
    return detectGraphqlError(body)
  },
  meta: {
    title: "monday.com",
    description: "Read monday.com boards, items and updates, create and change items, post updates, and list users, through the GraphQL API.",
    docsUrl: "https://developer.monday.com/api-reference/docs",
    status: "docs-based",
    credentialEnv: "MONDAY_API_TOKEN",
  },
  actions: {
    "me.get": graphqlAction({
      path: "/v2",
      description: "Get the user the token belongs to and their account. Use to check the token works.",
      query: "query Me { me { id name email account { id name } } }",
      field: "me",
      input: z.object({}),
      output: z.looseObject({ id: z.string(), name: z.string(), email: z.string().optional(), account: z.looseObject({ id: z.string().optional(), name: z.string().optional() }).nullish() }),
      effect: "read",
    }),
    "users.list": graphqlAction({
      path: "/v2",
      description: "List the users in the account (id, name, email, role flags). Guests are left out.",
      query: "query Users($limit: Int) { users(limit: $limit, kind: non_guests) { id name email is_admin is_guest enabled } }",
      field: "users",
      input: z.object({ limit }),
      output: z.array(z.looseObject({ id: z.string(), name: z.string(), email: z.string().optional(), is_admin: z.boolean().optional(), enabled: z.boolean().optional() })),
      effect: "read",
    }),
    "boards.list": graphqlAction({
      path: "/v2",
      description: "List active boards, most recently used first. Page with page = 1, 2, ... until fewer than limit come back.",
      query: "query Boards($limit: Int, $page: Int) { boards(limit: $limit, page: $page, state: active, order_by: used_at) { id name description state board_kind workspace { id name } } }",
      field: "boards",
      input: z.object({ limit, page: z.number().int().min(1).optional() }),
      output: z.array(board),
      effect: "read",
    }),
    "board.get": firstOf(
      graphqlAction({
        path: "/v2",
        description: "Get one board with its columns (id, title, type) and groups. You need the column ids to write column values.",
        query: "query Board($boardId: ID!) { boards(ids: [$boardId]) { id name description state board_kind columns { id title type } groups { id title } } }",
        field: "boards",
        input: z.object({ boardId }),
        output: board.extend({ columns: z.array(z.looseObject({ id: z.string(), title: z.string(), type: z.string() })).optional(), groups: z.array(z.looseObject({ id: z.string(), title: z.string() })).optional() }),
        effect: "read",
      }),
      "boards",
    ),
    "items.list": firstOf(
      graphqlAction({
        path: "/v2",
        description: "List the first page of items on a board with their column values. The result has a cursor: pass it to items.next for the next page; a null cursor means there are no more.",
        query: `query Items($boardId: ID!, $limit: Int) { boards(ids: [$boardId]) { items_page(limit: $limit) { cursor items { ${ITEM} } } } }`,
        field: "boards",
        input: z.object({ boardId, limit }),
        output: itemsPage,
        effect: "read",
      }),
      "boards",
      "items_page",
    ),
    "items.next": graphqlAction({
      path: "/v2",
      description: "Get the next page of items using the cursor from items.list or a previous items.next. A cursor expires after 60 minutes.",
      query: `query NextItems($cursor: String!, $limit: Int) { next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${ITEM} } } }`,
      field: "next_items_page",
      input: z.object({ cursor: z.string().min(1), limit }),
      output: itemsPage,
      effect: "read",
    }),
    "item.get": firstOf(
      graphqlAction({
        path: "/v2",
        description: "Get one item by id with its group, board and column values.",
        query: `query Item($itemId: ID!) { items(ids: [$itemId]) { ${ITEM} } }`,
        field: "items",
        input: z.object({ itemId }),
        output: item,
        effect: "read",
      }),
      "items",
    ),
    "updates.list": firstOf(
      graphqlAction({
        path: "/v2",
        description: "List the updates (comments) on an item, newest first, as plain text and HTML.",
        query: "query Updates($itemId: ID!, $limit: Int) { items(ids: [$itemId]) { updates(limit: $limit) { id body text_body created_at creator { id name } } } }",
        field: "items",
        input: z.object({ itemId, limit }),
        output: z.array(update),
        effect: "read",
      }),
      "items",
      "updates",
    ),
    "item.create": withJsonColumns(
      graphqlAction({
        path: "/v2",
        description: "Create an item on a board, optionally in a group and with column values. People following the board may be notified: ask a human first.",
        query: "mutation CreateItem($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) { create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) { id name } }",
        field: "create_item",
        input: z.object({ boardId, itemName: z.string().min(1).max(255), groupId: z.string().min(1).optional().describe("A group id from board.get. Default: the board's top group"), columnValues: columnValues.optional() }),
        output: z.looseObject({ id: z.string(), name: z.string().optional() }),
        effect: "write",
      }),
    ),
    "item.changeColumns": withJsonColumns(
      graphqlAction({
        path: "/v2",
        description: "Change several column values of an item at once (status, dates, people, text...). It overwrites the old values of those columns and may notify people: ask a human first.",
        query: "mutation ChangeColumns($boardId: ID!, $itemId: ID!, $columnValues: JSON!) { change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id name } }",
        field: "change_multiple_column_values",
        input: z.object({ boardId, itemId, columnValues: columnValues.refine((v) => Object.keys(v).length > 0, { message: "Give at least one column" }) }),
        output: z.looseObject({ id: z.string(), name: z.string().optional() }),
        effect: "write",
      }),
    ),
    "update.create": graphqlAction({
      path: "/v2",
      description: "Post an update (comment) on an item as the token's user. It notifies the people following the item: ask a human first.",
      query: "mutation CreateUpdate($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id body created_at } }",
      field: "create_update",
      input: z.object({ itemId, body: z.string().min(1).max(10_000).describe("The update text (basic HTML is allowed)") }),
      output: z.looseObject({ id: z.string(), body: z.string().optional(), created_at: z.string().nullish() }),
      effect: "write",
    }),
    "item.archive": graphqlAction({
      path: "/v2",
      description: "Archive an item: it disappears from the board and is deleted for good after 30 days unless restored in the app.",
      query: "mutation ArchiveItem($itemId: ID!) { archive_item(item_id: $itemId) { id } }",
      field: "archive_item",
      input: z.object({ itemId }),
      output: z.looseObject({ id: z.string() }),
      effect: "destructive",
    }),
    "item.delete": graphqlAction({
      path: "/v2",
      description: "Delete an item. It goes to the board's trash and is removed for good after 30 days: ask a human first.",
      query: "mutation DeleteItem($itemId: ID!) { delete_item(item_id: $itemId) { id } }",
      field: "delete_item",
      input: z.object({ itemId }),
      output: z.looseObject({ id: z.string() }),
      effect: "destructive",
    }),
  },
})

export default monday
