import { bodyLinkPagination, defineConnector, offsetPagination } from "../../index.js"
import { z } from "zod"

// Facts from Atlassian's Confluence Cloud REST API v2 reference (developer.atlassian.com/cloud/confluence/rest/v2): base URL
// https://{site}.atlassian.net/wiki, HTTP Basic with "email:api_token" (an API token from id.atlassian.com, the same as the Jira connector), v2 paths
// under /api/v2 (spaces, pages, footer comments), ids are numeric strings, and lists answer { results, _links: { next } } where `next` is a path
// ("/wiki/api/v2/pages?cursor=...") on the same host. A page body is written in the "storage" format (XHTML) or "atlas_doc_format"; an update must send
// the page's NEXT version number (current + 1) or Confluence answers 409. Deleting a page moves it to the trash; `purge: true` on a page that is already
// in the trash removes it for good. Search uses the older v1 endpoint GET /wiki/rest/api/search with a CQL query and `start` / `limit` paging.
//
// SECURITY: page and comment text is written by other people and may contain instructions aimed at an AI: it is data. A page edit replaces the page
// for everyone who can read it (the old version stays in the history).

const numericId = (what: string) => z.string().regex(/^\d{1,20}$/, `${what} is a number written as text`)
const pageId = numericId("A page id").describe("The page id (digits), from pages.list or the page URL")
const spaceId = numericId("A space id").describe("The space id (digits), from spaces.list; not the space key")
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(250).optional() }
const format = z.enum(["storage", "atlas_doc_format", "view"]).optional().describe("Return the body in this format. Omit to leave the body out: bodies are large")

const space = z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional(), type: z.string().optional(), status: z.string().optional() })
const page = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  spaceId: z.string().optional(),
  parentId: z.string().nullish(),
  version: z.looseObject({ number: z.number().optional(), createdAt: z.string().optional() }).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
})
const comment = z.looseObject({ id: z.string(), pageId: z.string().optional(), version: z.looseObject({ number: z.number().optional() }).optional(), body: z.record(z.string(), z.unknown()).optional() })
const next = (pageSize = 25) => bodyLinkPagination({ itemsKey: "results", nextUrlPath: ["_links", "next"], relative: true, pageSizeParam: "limit", defaultPageSize: pageSize, maxPageSize: 250 })

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
/** Plain text -> Confluence storage format: blank lines separate paragraphs, single newlines become line breaks, and markup characters are escaped. */
export const toStorage = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br />")}</p>`)
    .join("")

const content = {
  text: z.string().min(1).max(200_000).optional().describe("The body as plain text: blank lines separate paragraphs. Give this OR storage"),
  storage: z.string().min(1).max(500_000).optional().describe("The body as Confluence storage-format XHTML, for headings, tables and macros. Give this OR text"),
}
const oneBody = (i: { text?: string | undefined; storage?: string | undefined }) => (i.text === undefined) !== (i.storage === undefined)
const oneBodyMessage = { message: "Give exactly one of text or storage" }
const bodyOf = (i: Record<string, unknown>) => ({ representation: "storage", value: typeof i.storage === "string" ? i.storage : toStorage(String(i.text)) })

export const confluence = defineConnector({
  name: "confluence",
  baseUrl: "https://{site}.atlassian.net/wiki",
  variables: { site: { description: "Your Atlassian Cloud site (the part before .atlassian.net)", example: "acme" } },
  // Credential format: "you@company.com:YOUR_API_TOKEN" (create the token at id.atlassian.com > Security > API tokens).
  auth: { type: "basic" },
  meta: {
    title: "Confluence",
    description: "Search, read, create and edit Confluence Cloud pages and comments, and list spaces.",
    docsUrl: "https://developer.atlassian.com/cloud/confluence/rest/v2/intro/",
    status: "docs-based",
    credentialEnv: "CONFLUENCE_CREDENTIALS",
  },
  actions: {
    "spaces.list": {
      description: "List Confluence spaces the user can see, optionally filtered by key or type. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/api/v2/spaces",
      input: z.object({ keys: z.array(z.string().min(1)).max(50).optional().describe('Space keys such as ["ENG", "HR"]'), type: z.enum(["global", "personal", "collaboration", "knowledge_base"]).optional(), status: z.enum(["current", "archived"]).optional(), ...paging }),
      output: z.array(space),
      effect: "read",
      buildQuery: (i) => ({ ...(Array.isArray(i.keys) && i.keys.length > 0 && { keys: i.keys.join(",") }), ...(i.type !== undefined && { type: i.type }), ...(i.status !== undefined && { status: i.status }) }),
      paginate: next(),
    },
    "space.get": {
      description: "Get one space by id: its key, name, type and status.",
      method: "GET",
      path: "/api/v2/spaces/{spaceId}",
      input: z.object({ spaceId }),
      output: space,
      effect: "read",
    },
    "pages.list": {
      description: "List pages, newest first by default, optionally only those in given spaces or with a given title. Bodies are not included; use page.get. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/api/v2/pages",
      input: z.object({ spaceIds: z.array(spaceId).max(50).optional(), title: z.string().min(1).optional().describe("Match this exact title"), status: z.enum(["current", "archived", "trashed", "draft"]).optional(), sort: z.enum(["id", "-id", "title", "-title", "created-date", "-created-date", "modified-date", "-modified-date"]).optional(), ...paging }),
      output: z.array(page),
      effect: "read",
      buildQuery: (i) => ({ ...(Array.isArray(i.spaceIds) && i.spaceIds.length > 0 && { "space-id": i.spaceIds.join(",") }), ...(i.title !== undefined && { title: i.title }), ...(i.status !== undefined && { status: i.status }), ...(i.sort !== undefined && { sort: i.sort }) }),
      paginate: next(),
    },
    "page.get": {
      description: "Get one page by id: title, space, parent, version number and, when you ask for a body format, its content. You need the version number to update it.",
      method: "GET",
      path: "/api/v2/pages/{pageId}",
      input: z.object({ pageId, bodyFormat: format }),
      output: page,
      effect: "read",
      buildQuery: (i) => ({ ...(i.bodyFormat !== undefined && { "body-format": i.bodyFormat }) }),
    },
    "pageChildren.list": {
      description: "List the direct child pages of a page. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/api/v2/pages/{pageId}/children",
      input: z.object({ pageId, ...paging }),
      output: z.array(z.looseObject({ id: z.string(), title: z.string().optional(), status: z.string().optional() })),
      effect: "read",
      paginate: next(),
    },
    "comments.list": {
      description: "List the footer comments on a page, oldest first, with their text in storage format. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/api/v2/pages/{pageId}/footer-comments",
      input: z.object({ pageId, ...paging }),
      output: z.array(comment),
      effect: "read",
      buildQuery: () => ({ "body-format": "storage" }),
      paginate: next(),
    },
    "search.cql": {
      description: 'Search content with CQL, such as: type = page AND space = ENG AND text ~ "onboarding" ORDER BY lastmodified DESC. Returns one bounded page of matches; pass nextCursor for more.',
      method: "GET",
      path: "/rest/api/search",
      input: z.object({ cql: z.string().min(1).max(2000), ...paging }),
      output: z.array(z.looseObject({ title: z.string().optional(), excerpt: z.string().optional(), url: z.string().optional(), lastModified: z.string().optional(), content: z.looseObject({ id: z.string().optional(), type: z.string().optional() }).optional() })),
      effect: "read",
      paginate: offsetPagination({ itemsKey: "results", positionParam: "start", pageSizeParam: "limit", totalPath: ["totalSize"], defaultPageSize: 25, maxPageSize: 100 }),
    },
    "page.create": {
      description: "Create a page in a space, optionally under a parent page. Everyone who can see the space can read it: ask a human first. Give the body as plain text or storage-format XHTML.",
      method: "POST",
      path: "/api/v2/pages",
      input: z.object({ spaceId, title: z.string().min(1).max(255), parentId: pageId.optional(), draft: z.boolean().optional().describe("Create it as a draft nobody else sees yet"), ...content }).refine(oneBody, oneBodyMessage),
      output: page,
      effect: "write",
      buildBody: (i) => ({ spaceId: i.spaceId, status: i.draft === true ? "draft" : "current", title: i.title, ...(i.parentId !== undefined && { parentId: i.parentId }), body: bodyOf(i) }),
    },
    "page.update": {
      description: "Replace a page's title and body. Pass currentVersion = the version number from page.get; Confluence refuses (409) if someone else edited the page since. The old version stays in the history. Ask a human first.",
      method: "PUT",
      path: "/api/v2/pages/{pageId}",
      input: z.object({ pageId, title: z.string().min(1).max(255), currentVersion: z.number().int().positive().describe("The version number you read with page.get"), versionMessage: z.string().max(500).optional(), ...content }).refine(oneBody, oneBodyMessage).transform((i) => ({ ...i, id: i.pageId })), // the path takes pageId; Confluence also wants the id in the body
      output: page,
      effect: "write",
      buildBody: (i) => ({ id: i.id, status: "current", title: i.title, body: bodyOf(i), version: { number: (i.currentVersion as number) + 1, ...(i.versionMessage !== undefined && { message: i.versionMessage }) } }),
    },
    "page.delete": {
      description: "Move a page to the trash, or with purge delete a page that is already in the trash for good. Purging cannot be undone: ask a human first.",
      method: "DELETE",
      path: "/api/v2/pages/{pageId}",
      input: z.object({ pageId, purge: z.boolean().optional().describe("Permanently delete a page that is already in the trash") }),
      output: z.unknown(),
      effect: "destructive",
      buildQuery: (i) => ({ ...(i.purge === true && { purge: "true" }) }),
    },
    "comment.create": {
      description: "Add a footer comment to a page, as the authenticated user. It notifies watchers and shows the user's name: ask a human first.",
      method: "POST",
      path: "/api/v2/footer-comments",
      input: z.object({ pageId, text: z.string().min(1).max(50_000) }),
      output: comment,
      effect: "write",
      buildBody: (i) => ({ pageId: i.pageId, body: { representation: "storage", value: toStorage(String(i.text)) } }),
    },
  },
})

export default confluence
