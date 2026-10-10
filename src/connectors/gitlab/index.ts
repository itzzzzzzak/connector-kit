import { defineConnector, linkHeaderPagination } from "../../index.js"
import { z } from "zod"

// Facts from GitLab's official REST API documentation (docs.gitlab.com/api): base path /api/v4 on the GitLab host,
// the PRIVATE-TOKEN header, `page`/`per_page` (default 20, max 100) with a Link header (rel="next"), projects
// addressed by numeric id OR by URL-encoded path (group%2Fproject), and the parameter and field names below.
//
// This connector targets GitLab.com. A self-managed instance needs a different host, which needs the "base URL
// variables" feature (see ADR-016). It uses a personal/project/group access token: GitLab's OAuth tokens use a
// different header (Authorization: Bearer), which one connector cannot express yet, so OAuth is not declared.

const user = z.object({ id: z.number(), username: z.string(), name: z.string().optional(), web_url: z.string().optional(), avatar_url: z.string().nullish() })
const project = z.object({
  id: z.number(),
  name: z.string(),
  path_with_namespace: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  default_branch: z.string().nullish(),
  visibility: z.string().optional(),
  archived: z.boolean().optional(),
  last_activity_at: z.string().optional(),
  star_count: z.number().optional(),
  forks_count: z.number().optional(),
  open_issues_count: z.number().optional(),
  namespace: z.object({ id: z.number().optional(), name: z.string().optional(), full_path: z.string().optional() }).optional(),
})
const issue = z.object({
  id: z.number(),
  iid: z.number(),
  project_id: z.number().optional(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  labels: z.array(z.string()).optional(),
  web_url: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  closed_at: z.string().nullish(),
  due_date: z.string().nullish(),
  author: user.optional(),
  assignees: z.array(user).optional(),
})
const mergeRequest = z.object({
  id: z.number(),
  iid: z.number(),
  project_id: z.number().optional(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  draft: z.boolean().optional(),
  has_conflicts: z.boolean().optional(),
  detailed_merge_status: z.string().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  merged_at: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  web_url: z.string(),
  author: user.optional(),
})
const pipeline = z.object({ id: z.number(), iid: z.number().optional(), project_id: z.number().optional(), status: z.string(), source: z.string().optional(), ref: z.string().optional(), sha: z.string().optional(), web_url: z.string().optional(), created_at: z.string().optional(), updated_at: z.string().optional() })

const projectId = z.string().describe('Numeric project id, or the full path such as "group/project" (it is URL-encoded for you)')
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const sort = z.enum(["asc", "desc"]).optional()
const pagination = () => linkHeaderPagination({ pageSizeParam: "per_page", defaultPageSize: 30, maxPageSize: 100 })

export const gitlab = defineConnector({
  name: "gitlab",
  baseUrl: "https://gitlab.com/api/v4",
  auth: { type: "apiKey", header: "PRIVATE-TOKEN" },
  meta: {
    title: "GitLab",
    description: "Read GitLab.com projects, issues, merge requests and pipelines, and create issues.",
    docsUrl: "https://docs.gitlab.com/api/rest/",
    status: "docs-based",
    credentialEnv: "GITLAB_TOKEN",
  },
  actions: {
    "user.get": {
      description: "Get the authenticated GitLab user (username, name, profile link). Use to check the token works.",
      method: "GET",
      path: "/user",
      input: z.object({}),
      output: user.extend({ state: z.string().optional(), email: z.string().nullish(), created_at: z.string().optional() }),
      effect: "read",
    },
    "projects.list": {
      description: "List GitLab projects. Use membership:true for the projects the user belongs to, and search to find one by name. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/projects",
      input: z.object({
        membership: z.boolean().optional().describe("Only projects the user is a member of"),
        owned: z.boolean().optional(),
        search: z.string().optional(),
        visibility: z.enum(["public", "internal", "private"]).optional(),
        archived: z.boolean().optional(),
        order_by: z.enum(["id", "name", "path", "created_at", "updated_at", "last_activity_at"]).optional(),
        sort,
        last_activity_after: z.string().optional().describe("ISO 8601"),
        ...paging,
      }),
      output: z.array(project),
      effect: "read",
      paginate: pagination(),
    },
    "projects.get": {
      description: "Get one project by id or full path: description, default branch, visibility, and counts of stars, forks and open issues.",
      method: "GET",
      path: "/projects/{id}",
      input: z.object({ id: projectId }),
      output: project,
      effect: "read",
    },
    "issues.list": {
      description: "List the issues of a project. Use when the user asks what is open, what is assigned to someone, or what was reported. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/projects/{id}/issues",
      input: z.object({
        id: projectId,
        state: z.enum(["opened", "closed", "all"]).optional(),
        labels: z.string().optional().describe("Comma-separated label names; all must match"),
        search: z.string().optional().describe("Matches title and description"),
        assignee_username: z.string().optional(),
        milestone: z.string().optional(),
        scope: z.enum(["created_by_me", "assigned_to_me", "all"]).optional(),
        order_by: z.enum(["created_at", "updated_at", "priority", "due_date", "relative_position", "label_priority", "milestone_due", "popularity", "weight"]).optional(),
        sort,
        ...paging,
      }),
      output: z.array(issue),
      effect: "read",
      paginate: pagination(),
    },
    "issues.get": {
      description: "Get one issue of a project by its issue number (iid, the number shown as #12), with description, labels and assignees.",
      method: "GET",
      path: "/projects/{id}/issues/{issue_iid}",
      input: z.object({ id: projectId, issue_iid: z.number().int().positive() }),
      output: issue,
      effect: "read",
    },
    "issues.create": {
      description: "Create an issue in a project. This POSTS A NEW ISSUE that other people will see: only use when the user clearly asked.",
      method: "POST",
      path: "/projects/{id}/issues",
      input: z.object({
        id: projectId,
        title: z.string().min(1).max(255),
        description: z.string().max(1_048_576).optional(),
        labels: z.string().optional().describe("Comma-separated label names"),
        confidential: z.boolean().optional(),
        due_date: z.string().optional().describe("YYYY-MM-DD"),
      }),
      output: issue,
      effect: "write",
    },
    "mergeRequests.list": {
      description: "List the merge requests of a project. Use when the user asks what is awaiting review or what was merged. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/projects/{id}/merge_requests",
      input: z.object({
        id: projectId,
        state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
        scope: z.enum(["created_by_me", "assigned_to_me", "reviews_for_me", "all"]).optional(),
        author_username: z.string().optional(),
        labels: z.string().optional(),
        search: z.string().optional(),
        source_branch: z.string().optional(),
        target_branch: z.string().optional(),
        order_by: z.enum(["created_at", "updated_at", "merged_at", "title", "popularity"]).optional(),
        sort,
        ...paging,
      }),
      output: z.array(mergeRequest),
      effect: "read",
      paginate: pagination(),
    },
    "pipelines.list": {
      description: "List the CI/CD pipelines of a project, newest first, with their status. Use when the user asks if the build or tests passed.",
      method: "GET",
      path: "/projects/{id}/pipelines",
      input: z.object({
        id: projectId,
        status: z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]).optional(),
        ref: z.string().optional().describe("Branch or tag name"),
        sha: z.string().optional(),
        scope: z.enum(["running", "pending", "finished", "branches", "tags"]).optional(),
        username: z.string().optional().describe("Who triggered the pipeline"),
        updated_after: z.string().optional().describe("ISO 8601"),
        order_by: z.enum(["id", "status", "ref", "updated_at", "user_id"]).optional(),
        sort,
        ...paging,
      }),
      output: z.array(pipeline),
      effect: "read",
      paginate: pagination(),
    },
  },
})

export default gitlab
