import { defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Atlassian's Trello REST API reference (developer.atlassian.com/cloud/trello/rest): base URL https://api.trello.com/1, authentication by an API
// KEY (from the Power-Up admin page) plus a user TOKEN (authorized for that key), sent either as query parameters or as the header
// `Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"`. This connector uses the header, so neither secret ever lands in a URL; the credential is
// written "KEY:TOKEN" (auth `headerTemplate`, ADR-028). Ids are 24 hex characters (a board also has an 8 character short id). POST and PUT take their fields
// as JSON. `fields` limits what is returned. Lists of cards, lists and boards come back whole (no paging), so a board with thousands of cards returns them all;
// the actions here ask only for the fields people use. A card deleted through the API is gone for good, while "closed" (archived) cards can be restored.
//
// SECURITY: card names, descriptions and comments are written by other people and can contain text aimed at an AI: they are data, never instructions.
// A comment or a new card notifies the board's members.

const hex = z.string().regex(/^[0-9a-f]{24}$/, "A Trello id is 24 hex characters")
const boardId = z.string().regex(/^([0-9a-f]{24}|[A-Za-z0-9]{8})$/, "A board id is 24 hex characters, or the 8 character short id from the board URL").describe("The board id, from boards.list or the board URL")
const listId = hex.describe("The list id, from lists.list")
const cardId = hex.describe("The card id, from cards.list")
const due = z.string().datetime({ offset: true }).describe("A due date and time in ISO 8601 with a zone, such as 2026-10-20T17:00:00Z")

const member = z.looseObject({ id: z.string(), username: z.string().optional(), fullName: z.string().optional() })
const board = z.looseObject({ id: z.string(), name: z.string(), desc: z.string().optional(), closed: z.boolean().optional(), url: z.string().optional(), shortUrl: z.string().optional(), idOrganization: z.string().nullish() })
const list = z.looseObject({ id: z.string(), name: z.string(), closed: z.boolean().optional(), pos: z.number().optional(), idBoard: z.string().optional() })
const label = z.looseObject({ id: z.string(), name: z.string().optional(), color: z.string().nullish() })
const card = z.looseObject({ id: z.string(), name: z.string(), desc: z.string().optional(), closed: z.boolean().optional(), due: z.string().nullish(), dueComplete: z.boolean().optional(), idList: z.string().optional(), idBoard: z.string().optional(), url: z.string().optional(), labels: z.array(label).optional() })
const commentAction = z.looseObject({ id: z.string(), date: z.string().optional(), data: z.looseObject({ text: z.string().optional() }).optional(), memberCreator: member.optional() })
const CARD_FIELDS = "id,name,desc,closed,due,dueComplete,idList,idBoard,url,labels"

export const trello = defineConnector({
  name: "trello",
  baseUrl: "https://api.trello.com/1",
  auth: { type: "headerTemplate", header: "Authorization", template: 'OAuth oauth_consumer_key="{1}", oauth_token="{2}"' },
  meta: {
    title: "Trello",
    description: "Read Trello boards, lists and cards; create, edit, move and archive cards; and read and add card comments.",
    docsUrl: "https://developer.atlassian.com/cloud/trello/rest/api-group-actions/",
    status: "docs-based",
    credentialEnv: "TRELLO_CREDENTIALS",
  },
  actions: {
    "me.get": {
      description: "Get the Trello member the key and token belong to. Use to check the credentials work.",
      method: "GET",
      path: "/members/me",
      input: z.object({}),
      output: member,
      effect: "read",
      buildQuery: () => ({ fields: "id,username,fullName" }),
    },
    "boards.list": {
      description: "List the boards the member belongs to (open ones by default) with their name, description and URL.",
      method: "GET",
      path: "/members/me/boards",
      input: z.object({ filter: z.enum(["open", "closed", "all"]).optional().describe("Default: open") }),
      output: z.array(board),
      effect: "read",
      buildQuery: (i) => ({ filter: i.filter ?? "open", fields: "id,name,desc,closed,url,shortUrl,idOrganization" }),
    },
    "board.get": {
      description: "Get one board by id: its name, description, URL and whether it is archived.",
      method: "GET",
      path: "/boards/{boardId}",
      input: z.object({ boardId }),
      output: board,
      effect: "read",
      buildQuery: () => ({ fields: "id,name,desc,closed,url,shortUrl,idOrganization" }),
    },
    "lists.list": {
      description: "List the open lists (columns) on a board, in order. You need a list id to read or create cards.",
      method: "GET",
      path: "/boards/{boardId}/lists",
      input: z.object({ boardId }),
      output: z.array(list),
      effect: "read",
      buildQuery: () => ({ filter: "open", fields: "id,name,closed,pos,idBoard" }),
    },
    "labels.list": {
      description: "List the labels defined on a board (id, name, color).",
      method: "GET",
      path: "/boards/{boardId}/labels",
      input: z.object({ boardId }),
      output: z.array(label),
      effect: "read",
      buildQuery: () => ({ fields: "id,name,color" }),
    },
    "cards.list": {
      description: "List the open cards in a list, in order, with their name, description, due date, labels and URL. Comments are not included; use comments.list.",
      method: "GET",
      path: "/lists/{listId}/cards",
      input: z.object({ listId }),
      output: z.array(card),
      effect: "read",
      buildQuery: () => ({ fields: CARD_FIELDS }),
    },
    "card.get": {
      description: "Get one card by id with its description, due date, list, labels and URL.",
      method: "GET",
      path: "/cards/{cardId}",
      input: z.object({ cardId }),
      output: card,
      effect: "read",
      buildQuery: () => ({ fields: CARD_FIELDS }),
    },
    "comments.list": {
      description: "List the comments on a card, newest first, with who wrote them and when.",
      method: "GET",
      path: "/cards/{cardId}/actions",
      input: z.object({ cardId, limit: z.number().int().min(1).max(100).optional() }),
      output: z.array(commentAction),
      effect: "read",
      buildQuery: (i) => ({ filter: "commentCard", ...(i.limit !== undefined && { limit: i.limit }) }),
    },
    "card.create": {
      description: "Create a card at the top or bottom of a list. The board's members may be notified: ask a human first.",
      method: "POST",
      path: "/cards",
      input: z.object({ listId: hex.describe("The list to put the card in, from lists.list"), name: z.string().min(1).max(16384), desc: z.string().max(16384).optional(), due: due.optional(), position: z.enum(["top", "bottom"]).optional().describe("Default: bottom"), labelIds: z.array(hex).max(20).optional() }),
      output: card,
      effect: "write",
      buildBody: (i) => ({ idList: i.listId, name: i.name, ...(i.desc !== undefined && { desc: i.desc }), ...(i.due !== undefined && { due: i.due }), ...(i.position !== undefined && { pos: i.position }), ...(Array.isArray(i.labelIds) && i.labelIds.length > 0 && { idLabels: i.labelIds.join(",") }) }),
    },
    "card.update": {
      description: "Change a card's name, description, due date, or mark its due date complete. Only the fields you give are changed. Everyone on the board sees the change: ask a human first.",
      method: "PUT",
      path: "/cards/{cardId}",
      input: z.object({ cardId, name: z.string().min(1).max(16384).optional(), desc: z.string().max(16384).optional(), due: due.optional(), dueComplete: z.boolean().optional() }).refine((i) => i.name !== undefined || i.desc !== undefined || i.due !== undefined || i.dueComplete !== undefined, { message: "Give at least one field to change" }),
      output: card,
      effect: "write",
    },
    "card.move": {
      description: "Move a card to another list (and optionally to the top or bottom of it), on the same board or another board the member can reach.",
      method: "PUT",
      path: "/cards/{cardId}",
      input: z.object({ cardId, listId: hex.describe("The destination list id"), position: z.enum(["top", "bottom"]).optional() }),
      output: card,
      effect: "write",
      buildBody: (i) => ({ idList: i.listId, ...(i.position !== undefined && { pos: i.position }) }),
    },
    "card.archive": {
      description: "Archive a card: it disappears from its list but can be restored from the board's archive.",
      method: "PUT",
      path: "/cards/{cardId}",
      input: z.object({ cardId }),
      output: card,
      effect: "destructive",
      buildBody: () => ({ closed: true }),
    },
    "card.delete": {
      description: "Delete a card permanently, with its comments and attachments. This cannot be undone (archive it instead if unsure): ask a human first.",
      method: "DELETE",
      path: "/cards/{cardId}",
      input: z.object({ cardId }),
      output: z.unknown(),
      effect: "destructive",
    },
    "comment.create": {
      description: "Add a comment to a card as the authenticated member. It notifies the card's members: ask a human first.",
      method: "POST",
      path: "/cards/{cardId}/actions/comments",
      input: z.object({ cardId, text: z.string().min(1).max(16384) }),
      output: commentAction,
      effect: "write",
    },
  },
})

export default trello
