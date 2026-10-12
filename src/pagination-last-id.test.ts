import assert from "node:assert/strict"
import { test } from "node:test"
import { lastIdPagination } from "./index.js"

const response = (body: unknown, limit: number) => ({ headers: new Headers(), body, url: new URL(`https://api.test/items?limit=${limit}`) })

test("last-id paging: a full page continues from the last item's id, a short one ends", () => {
  const strategy = lastIdPagination({ cursorParam: "before" })
  assert.equal(strategy.nextCursor(response([{ id: "30" }, { id: "20" }], 2)), "20")
  assert.equal(strategy.nextCursor(response([{ id: "30" }], 2)), null)
  assert.equal(strategy.nextCursor(response([], 2)), null)
  assert.equal(strategy.nextCursor(response({ message: "not a list" }, 2)), null)
})

test("last-id paging: the cursor goes back as before or after, and a nested id can be named", () => {
  assert.equal(lastIdPagination({ cursorParam: "before" }).applyCursor(new URL("https://api.test/items?limit=2"), "20").search, "?limit=2&before=20")
  assert.equal(lastIdPagination({ cursorParam: "after" }).applyCursor(new URL("https://api.test/items?limit=2"), "20").search, "?limit=2&after=20")
  const members = lastIdPagination({ cursorParam: "after", idKey: "user.id" })
  assert.equal(members.nextCursor(response([{ user: { id: "5" } }, { user: { id: "9" } }], 2)), "9")
})
