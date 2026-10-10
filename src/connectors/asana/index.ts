import { bodyCursorPagination, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts come from Asana's official OpenAPI spec (github.com/Asana/openapi): base URL, paths, pagination
// (`next_page.offset` sent back as `offset`), `{ "data": ... }` envelopes, and the OAuth endpoints.

const ref = z.object({ gid: z.string(), name: z.string().nullish(), resource_type: z.string().optional() })

// Asana returns compact records unless you ask for more with `opt_fields`, so each read below asks for a useful
// default. Objects are "loose": any extra field the caller requests through opt_fields is kept.
const user = z.looseObject({ gid: z.string(), name: z.string().nullish(), email: z.string().nullish(), workspaces: z.array(ref).optional() })
const project = z.looseObject({
  gid: z.string(),
  name: z.string().nullish(),
  archived: z.boolean().optional(),
  color: z.string().nullish(),
  owner: ref.nullish(),
  permalink_url: z.string().optional(),
  workspace: ref.optional(),
  notes: z.string().optional(),
})
const task = z.looseObject({
  gid: z.string(),
  name: z.string().nullish(),
  resource_subtype: z.string().optional(),
  completed: z.boolean().optional(),
  due_on: z.string().nullish(),
  assignee: ref.nullish(),
  notes: z.string().optional(),
  permalink_url: z.string().optional(),
  projects: z.array(ref).optional(),
  parent: ref.nullish(),
})

const fields = (list: string) => z.string().default(list).describe("Comma-separated fields to return (Asana returns only ids and names unless asked). Dot paths work, e.g. assignee.name.")
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const pagination = () => bodyCursorPagination({ itemsKey: "data", cursorPath: ["next_page", "offset"], cursorParam: "offset", pageSizeParam: "limit", defaultPageSize: 30, maxPageSize: 100 })
const TASK_FIELDS = "name,completed,due_on,assignee.name,notes,permalink_url,projects.name,parent.name"

export const asana = defineConnector({
  name: "asana",
  baseUrl: "https://app.asana.com/api/1.0",
  // A personal access token works as a Bearer token; OAuth is for apps acting for many users.
  auth: { type: "oauth2", authorizeUrl: "https://app.asana.com/-/oauth_authorize", tokenUrl: "https://app.asana.com/-/oauth_token" },
  meta: {
    title: "Asana",
    description: "Read workspaces, projects and tasks, and create or update tasks.",
    docsUrl: "https://developers.asana.com/reference/rest-api-reference",
    status: "docs-based",
    credentialEnv: "ASANA_TOKEN",
  },
  actions: {
    "users.get": {
      description: 'Get a user. Pass "me" as user_gid for the authenticated user. Use first to find the workspaces the token can see.',
      method: "GET",
      path: "/users/{user_gid}",
      input: z.object({ user_gid: z.string().describe('A user gid, or "me"'), opt_fields: fields("name,email,workspaces.name") }),
      output: z.object({ data: user }),
      effect: "read",
    },
    "workspaces.list": {
      description: "List the workspaces (and organizations) the token can access. Use to find a workspace gid for other calls.",
      method: "GET",
      path: "/workspaces",
      input: z.object({ ...paging }),
      output: z.array(ref),
      effect: "read",
      paginate: pagination(),
    },
    "projects.list": {
      description: "List projects in a workspace or team. Use when the user asks what projects exist. Give a workspace gid (or a team gid).",
      method: "GET",
      path: "/projects",
      input: z.object({
        workspace: z.string().optional().describe("Workspace gid (give this or team)"),
        team: z.string().optional().describe("Team gid"),
        archived: z.boolean().optional().describe("Only archived (true) or only active (false) projects"),
        opt_fields: fields("name,archived,owner.name,permalink_url"),
        ...paging,
      }),
      output: z.array(project),
      effect: "read",
      paginate: pagination(),
    },
    "projects.get": {
      description: "Get one project by gid, with its owner, workspace and notes.",
      method: "GET",
      path: "/projects/{project_gid}",
      input: z.object({ project_gid: z.string(), opt_fields: fields("name,archived,owner.name,permalink_url,workspace.name,notes") }),
      output: z.object({ data: project }),
      effect: "read",
    },
    "projects.tasks.list": {
      description: "List the tasks in a project. Use when the user asks what is in a project or what is due. Returns one bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/projects/{project_gid}/tasks",
      input: z.object({
        project_gid: z.string(),
        completed_since: z.string().optional().describe('ISO time, or "now" for only incomplete tasks'),
        opt_fields: fields("name,completed,due_on,assignee.name,permalink_url"),
        ...paging,
      }),
      output: z.array(task),
      effect: "read",
      paginate: pagination(),
    },
    "tasks.get": {
      description: "Get one task by gid, with notes, assignee, due date and the projects it belongs to.",
      method: "GET",
      path: "/tasks/{task_gid}",
      input: z.object({ task_gid: z.string(), opt_fields: fields(TASK_FIELDS) }),
      output: z.object({ data: task }),
      effect: "read",
    },
    "tasks.create": {
      description: "Create a task. This CHANGES the user's Asana: only use when they clearly asked. Give at least one of workspace, projects or parent.",
      method: "POST",
      path: "/tasks",
      input: z.object({
        name: z.string().min(1).max(1000),
        notes: z.string().max(65_000).optional(),
        workspace: z.string().optional().describe("Workspace gid (required unless projects or parent is given)"),
        projects: z.array(z.string()).optional().describe("Project gids to add the task to"),
        parent: z.string().optional().describe("Parent task gid, to create a subtask"),
        assignee: z.string().optional().describe('User gid, or "me"'),
        due_on: z.string().optional().describe("Due date, YYYY-MM-DD"),
      }),
      output: z.object({ data: task }),
      effect: "write",
      buildBody: (input) => ({ data: input }), // Asana wants { "data": { ... } }
    },
    "tasks.update": {
      description: "Update a task: rename it, change notes, mark it complete, reassign it or change the due date. This CHANGES the user's Asana: only use when they clearly asked.",
      method: "PUT",
      path: "/tasks/{task_gid}",
      input: z.object({
        task_gid: z.string(),
        name: z.string().min(1).max(1000).optional(),
        notes: z.string().max(65_000).optional(),
        completed: z.boolean().optional(),
        assignee: z.string().nullable().optional().describe('User gid, "me", or null to unassign'),
        due_on: z.string().nullable().optional().describe("YYYY-MM-DD, or null to clear"),
      }),
      output: z.object({ data: task }),
      effect: "write",
      safeToRetry: true, // PUT sets fields to the given values: repeating it changes nothing further
      buildBody: (input) => ({ data: input }),
    },
  },
})

export default asana
