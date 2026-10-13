import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import trello from "./index.js"

const id = (n: number) => String(n).repeat(24).slice(0, 24).replace(/[^0-9]/g, "1")
const BOARD = id(1), LIST = id(2), CARD = id(3), LABEL = id(4)
const card = { id: CARD, name: "Write docs", desc: "", closed: false, due: null, idList: LIST, idBoard: BOARD, url: "https://trello.com/c/abc" }
const comment = { id: id(5), date: "2026-10-13T08:00:00.000Z", data: { text: "hi" }, memberCreator: { id: id(6), username: "ak" } }
const connect = { credentials: { token: "KEY123:TOKEN456" } }
const opts = { connect }

standardTests(trello, { action: "me.get", input: {}, ok: { id: id(6), username: "ak" }, ...opts })
standardTests(trello, { action: "boards.list", input: {}, ok: [{ id: BOARD, name: "Roadmap" }], badInput: { filter: "nope" }, ...opts })
standardTests(trello, { action: "board.get", input: { boardId: BOARD }, ok: { id: BOARD, name: "Roadmap" }, badInput: { boardId: "x" }, ...opts })
standardTests(trello, { action: "lists.list", input: { boardId: BOARD }, ok: [{ id: LIST, name: "Todo" }], badInput: { boardId: "x" }, ...opts })
standardTests(trello, { action: "labels.list", input: { boardId: BOARD }, ok: [{ id: LABEL, name: "bug", color: "red" }], badInput: { boardId: "x" }, ...opts })
standardTests(trello, { action: "cards.list", input: { listId: LIST }, ok: [card], badInput: { listId: "x" }, ...opts })
standardTests(trello, { action: "card.get", input: { cardId: CARD }, ok: card, badInput: { cardId: "x" }, ...opts })
standardTests(trello, { action: "comments.list", input: { cardId: CARD }, ok: [comment], badInput: { cardId: CARD, limit: 0 }, ...opts })
standardTests(trello, { action: "card.create", input: { listId: LIST, name: "Write docs" }, ok: card, badInput: { listId: LIST, name: "" }, ...opts })
standardTests(trello, { action: "card.update", input: { cardId: CARD, name: "New" }, ok: card, badInput: { cardId: CARD }, ...opts })
standardTests(trello, { action: "card.move", input: { cardId: CARD, listId: LIST }, ok: card, badInput: { cardId: CARD, listId: "x" }, ...opts })
standardTests(trello, { action: "card.archive", input: { cardId: CARD }, ok: { ...card, closed: true }, badInput: { cardId: "x" }, ...opts })
standardTests(trello, { action: "card.delete", input: { cardId: CARD }, ok: {}, badInput: { cardId: "x" }, ...opts })
standardTests(trello, { action: "comment.create", input: { cardId: CARD, text: "hi" }, ok: comment, badInput: { cardId: CARD, text: "" }, ...opts })

test("the key and token go in one OAuth Authorization header, never in the URL", async () => {
  const { conn, calls } = harness(trello, () => json([card]), connect)
  await conn.execute("cards.list", { listId: LIST })
  assert.equal(calls[0]!.header("authorization"), 'OAuth oauth_consumer_key="KEY123", oauth_token="TOKEN456"')
  assert.equal(calls[0]!.url.pathname, `/1/lists/${LIST}/cards`)
  assert.ok(!calls[0]!.url.search.includes("KEY123") && !calls[0]!.url.search.includes("TOKEN456"))
})

test("card.move sends the list and position as JSON; card.archive sends closed: true", async () => {
  const { conn, calls } = harness(trello, () => json(card), connect)
  await conn.execute("card.move", { cardId: CARD, listId: LIST, position: "top" })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.deepEqual(calls[0]!.body, { idList: LIST, pos: "top" })
  await conn.execute("card.archive", { cardId: CARD })
  assert.deepEqual(calls[1]!.body, { closed: true })
})

test("card.update needs at least one field and sends only the ones given", async () => {
  const { conn, calls } = harness(trello, () => json(card), connect)
  await assert.rejects(() => conn.execute("card.update", { cardId: CARD }))
  await conn.execute("card.update", { cardId: CARD, dueComplete: true })
  assert.deepEqual(calls[0]!.body, { dueComplete: true })
})

test("card.create sends label ids as a comma list", async () => {
  const { conn, calls } = harness(trello, () => json(card), connect)
  await conn.execute("card.create", { listId: LIST, name: "n", labelIds: [LABEL, BOARD] })
  assert.deepEqual(calls[0]!.body, { idList: LIST, name: "n", idLabels: `${LABEL},${BOARD}` })
})
