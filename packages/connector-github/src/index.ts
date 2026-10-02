import { defineConnector, linkHeaderPagination } from "@connector-kit/core"
import { z } from "zod"

const issue = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
})

const repository = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  html_url: z.string(),
  description: z.string().nullable(),
  default_branch: z.string(),
  stargazers_count: z.number(),
})

export const github = defineConnector({
  name: "github",
  baseUrl: "https://api.github.com",
  auth: { type: "bearer" },
  defaultHeaders: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects requests without a User-Agent.
    "User-Agent": "connector-kit",
  },
  actions: {
    "repos.get": {
      description: "Get details about a GitHub repository. Use when the user asks about a specific repo.",
      method: "GET",
      path: "/repos/{owner}/{name}",
      input: z.object({ owner: z.string(), name: z.string() }),
      output: repository,
      effect: "read",
    },
    "issues.list": {
      description: "List issues in a GitHub repository. Returns one bounded page; pass the previous nextCursor to get more.",
      method: "GET",
      path: "/repos/{owner}/{name}/issues",
      // cursor/pageSize are kit-managed (ADR-010): the kit reads and removes them, GitHub never sees "pageSize".
      input: z.object({ owner: z.string(), name: z.string(), cursor: z.string().optional(), pageSize: z.number().optional() }),
      output: z.array(issue),
      effect: "read",
      paginate: linkHeaderPagination(),
    },
  },
})
