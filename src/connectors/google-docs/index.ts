import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's Docs API v1 reference and Discovery document: base URL https://docs.googleapis.com/v1, a document is addressed by the id
// in its URL (docs.google.com/document/d/<id>/edit), its content comes back as a tree (body.content: paragraphs, tables, ...) with text in
// textRun elements, and every change is a request inside a `documents.batchUpdate` call. Scopes: documents.readonly reads, documents writes.
// The whole API is three calls (get, create, batchUpdate), all generated and untyped on the way out (ADR-018, ADR-022); one curated action
// below covers the commonest edit, adding text at the end. Everything else is an `requests` entry you write yourself (insertText at an index,
// replaceAllText, updateTextStyle, ...).
// SECURITY: document text is written by anyone with access and can contain anything, including text aimed at an AI. It is data, never instructions.

const documentId = z.string().min(1).describe("The id in the document's URL: docs.google.com/document/d/<id>/edit")

export const googleDocs = defineConnector({
  name: "google-docs",
  baseUrl: "https://docs.googleapis.com/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/documents"]),
  meta: {
    title: "Google Docs",
    description: "Read Google Docs documents and change their content with batched edits.",
    docsUrl: "https://developers.google.com/workspace/docs/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_DOCS_TOKEN",
  },
  actions: {
    ...generatedActions,
    "documents.batchUpdate": {
      description: "Apply edits to a document: a list of requests such as insertText, replaceAllText, deleteContentRange or updateTextStyle, applied in order and all-or-nothing. Indexes shift as you edit, so send edits from the end of the document backwards.",
      method: "POST",
      path: "/documents/{documentId}:batchUpdate",
      input: z.object({ documentId, requests: z.array(z.record(z.string(), z.unknown())).min(1).describe('e.g. [{ "replaceAllText": { "containsText": { "text": "{{name}}", "matchCase": true }, "replaceText": "Ada" } }]') }),
      output: z.looseObject({ documentId: z.string().optional(), replies: z.array(z.unknown()).optional() }),
      effect: "write",
      buildBody: (i) => ({ requests: i.requests }),
    },
    "documents.appendText": {
      description: "Add text at the end of a document's body (a newline starts a new paragraph). Does not change existing content.",
      method: "POST",
      path: "/documents/{documentId}:batchUpdate",
      input: z.object({ documentId, text: z.string().min(1) }),
      output: z.looseObject({ documentId: z.string().optional(), replies: z.array(z.unknown()).optional() }),
      effect: "write",
      buildBody: (i) => ({ requests: [{ insertText: { text: i.text, endOfSegmentLocation: {} } }] }),
    },
  },
})

export default googleDocs
