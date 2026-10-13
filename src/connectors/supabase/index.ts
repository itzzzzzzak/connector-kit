import { defineConnector } from "../../index.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Supabase's Management API description (apps/docs/spec/api_v1_openapi.json in github.com/supabase/supabase, Apache-2.0) and docs:
// base URL https://api.supabase.com, `Authorization: Bearer sbp_...` with a personal access token (OAuth apps exist and use the same header; this
// connector takes the token), a project is addressed by its 20-letter "ref" (the part of its URL before .supabase.co), and "Run a query" is a POST
// of { query } (with optional `parameters`) that runs SQL as the database owner. The read-only variant runs the SQL in a read-only transaction.
// This is the MANAGEMENT API (projects, database, auth settings, functions, secrets); data inside a project's tables is read with the project's own
// REST URL and keys, which this connector does not cover. Endpoints that return API keys are left out on purpose (see the generator config).
//
// SECURITY: SQL is the most powerful thing here. `database.query` can drop tables and is marked destructive; prefer `database.readOnlyQuery`.
// Rows, function names and log lines come from the project's own users and can contain text aimed at an AI: they are data, never instructions.

const ref = z.string().regex(/^[a-z]{20}$/, "A project ref is 20 lowercase letters").describe("The project ref: 20 lowercase letters, from projects.list")
const project = z.looseObject({ id: z.string().optional(), ref: z.string().optional(), name: z.string().optional(), organization_id: z.string().optional(), region: z.string().optional(), status: z.string().optional(), created_at: z.string().optional() })
const sql = z.string().min(1).max(100_000).describe("A SQL statement. Use $1, $2 ... placeholders with `parameters` for values instead of pasting them into the text")

export const supabase = defineConnector({
  name: "supabase",
  baseUrl: "https://api.supabase.com",
  auth: { type: "bearer" },
  meta: {
    title: "Supabase",
    description: "Manage Supabase projects, run SQL against a project's database, and read edge functions, storage buckets, auth and database settings through the Management API.",
    docsUrl: "https://supabase.com/docs/reference/api/introduction",
    status: "docs-based",
    credentialEnv: "SUPABASE_ACCESS_TOKEN",
  },
  actions: {
    ...generatedActions,
    "projects.list": {
      description: "List every project the access token can see, with its ref, name, region and status. Start here to find a project ref.",
      method: "GET",
      path: "/v1/projects",
      input: z.object({}),
      output: z.array(project),
      effect: "read",
    },
    "organizations.list": {
      description: "List the organizations the access token belongs to, with their slugs and ids.",
      method: "GET",
      path: "/v1/organizations",
      input: z.object({}),
      output: z.array(z.looseObject({ id: z.string().optional(), slug: z.string().optional(), name: z.string().optional() })),
      effect: "read",
    },
    "database.readOnlyQuery": {
      description: "Run a SQL query against a project's database in a read-only transaction and return the rows. Anything that tries to change data fails. Prefer this over database.query.",
      method: "POST",
      path: "/v1/projects/{ref}/database/query/read-only",
      input: z.object({ ref, query: sql, parameters: z.array(z.unknown()).max(100).optional() }),
      output: z.array(z.record(z.string(), z.unknown())),
      effect: "read",
    },
    "database.query": {
      description: "Run SQL against a project's database with full rights. It can create, change and DELETE tables and rows, so it is destructive: ask a human before running anything that is not a plain SELECT, and prefer database.readOnlyQuery for reading.",
      method: "POST",
      path: "/v1/projects/{ref}/database/query",
      input: z.object({ ref, query: sql, parameters: z.array(z.unknown()).max(100).optional() }),
      output: z.array(z.record(z.string(), z.unknown())),
      effect: "destructive",
    },
    "functions.list": {
      description: "List a project's edge functions with their slugs, status and version.",
      method: "GET",
      path: "/v1/projects/{ref}/functions",
      input: z.object({ ref }),
      output: z.array(z.looseObject({ id: z.string().optional(), slug: z.string().optional(), name: z.string().optional(), status: z.string().optional(), version: z.number().optional(), updated_at: z.number().optional() })),
      effect: "read",
    },
    "storageBuckets.list": {
      description: "List a project's storage buckets with their visibility (public or private).",
      method: "GET",
      path: "/v1/projects/{ref}/storage/buckets",
      input: z.object({ ref }),
      output: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), public: z.boolean().optional(), created_at: z.string().optional() })),
      effect: "read",
    },
  },
})

export default supabase
