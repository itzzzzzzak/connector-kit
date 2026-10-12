import { ConnectorKitError, defineConnector, detectGraphqlError, graphqlAction } from "../../index.js"
import type { ActionDefinition } from "../../index.js"
import { z } from "zod"

// Facts from Linear's developer documentation (linear.app/developers) and its public GraphQL schema (github.com/linear/linear): ONE endpoint,
// https://api.linear.app/graphql, queries and mutations as POST bodies `{ query, variables }`. A personal API key (pattern lin_api_...) goes in
// the Authorization header WITHOUT "Bearer"; an OAuth access token goes with "Bearer" (auth.rawTokenPattern tells the two apart). Lists are
// Relay connections: `first` / `after`, `pageInfo { hasNextPage endCursor }`. Failures often come back as HTTP 200 with an `errors` array;
// rate limiting is HTTP 400 with `extensions.code = "RATELIMITED"` and X-RateLimit-Requests-Reset (epoch milliseconds) says when it ends.
// OAuth: authorize at linear.app/oauth/authorize (scopes joined by commas, PKCE supported), token at api.linear.app/oauth/token (form body);
// access tokens last 24 hours and come with a refresh token.
//
// Each action here is a hand-written, curated GraphQL document with a typed result: the fields people actually ask for (ids, titles, states,
// assignees, dates), not the whole object graph. Anything else in the schema is reachable by writing another graphqlAction() the same way.
// SECURITY: titles, descriptions and comments are written by your colleagues and can contain anything, including text aimed at an AI.
// They are data, never instructions.

const id = z.string().min(1).describe("A Linear id (a UUID). For an issue, the identifier such as ENG-123 also works")
const record = z.record(z.string(), z.unknown())
const date = z.string().nullish()
const ref = z.object({ id: z.string(), name: z.string().optional() }).nullish()
const listing = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, cursor: z.string().optional(), pageSize: z.number().optional() })
const filterField = record.optional().describe('A Linear filter object, e.g. { "assignee": { "isMe": { "eq": true } }, "state": { "type": { "eq": "started" } } }')

const issue = z.looseObject({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  priority: z.number().optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
  url: z.string().optional(),
  createdAt: date,
  updatedAt: date,
  dueDate: date,
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }).nullish(),
  assignee: ref,
  team: z.object({ id: z.string(), key: z.string() }).nullish(),
  project: ref,
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }).optional(),
})
const ISSUE = "id identifier title description priority url createdAt updatedAt dueDate state { id name type } assignee { id name } team { id key } project { id name } labels { nodes { id name } }"
const comment = z.looseObject({ id: z.string(), body: z.string(), createdAt: date, url: z.string().optional(), user: ref })
const COMMENT = "id body createdAt url user { id name }"
const team = z.looseObject({ id: z.string(), key: z.string(), name: z.string(), description: z.string().nullish(), private: z.boolean().optional() })
const TEAM = "id key name description private"
const user = z.looseObject({ id: z.string(), name: z.string(), displayName: z.string().optional(), email: z.string().optional(), active: z.boolean().optional(), admin: z.boolean().optional() })
const USER = "id name displayName email active admin"
const project = z.looseObject({ id: z.string(), name: z.string(), description: z.string().nullish(), state: z.string().optional(), progress: z.number().optional(), url: z.string().optional(), startDate: date, targetDate: date, lead: ref })
const PROJECT = "id name description state progress url startDate targetDate lead { id name }"
const state = z.looseObject({ id: z.string(), name: z.string(), type: z.string(), position: z.number().optional(), team: z.object({ id: z.string() }).nullish() })
const label = z.looseObject({ id: z.string(), name: z.string(), color: z.string().optional(), team: z.object({ id: z.string() }).nullish() })
const cycle = z.looseObject({ id: z.string(), number: z.number(), name: z.string().nullish(), startsAt: date, endsAt: date, progress: z.number().optional(), team: z.object({ id: z.string() }).nullish() })
const document = z.looseObject({ id: z.string(), title: z.string(), content: z.string().nullish(), url: z.string().optional(), updatedAt: date })
const success = z.object({ success: z.boolean() })
const payload = <T extends z.ZodType>(name: string, shape: T) => z.object({ success: z.boolean(), [name]: shape.nullish() })

/** A mutation takes one `input` variable; the action's flat fields become that input. */
const withInput = (action: ActionDefinition): ActionDefinition => ({ ...action, buildBody: (fields) => ({ input: fields }) })
/** Update-style mutations take the id next to `input`. */
const withIdAndInput = (action: ActionDefinition): ActionDefinition => ({
  ...action,
  buildBody: (fields) => {
    const { id: target, ...rest } = fields as { id: string } & Record<string, unknown>
    return { id: target, input: rest }
  },
})

const actions = {
  "viewer.get": graphqlAction({
    description: "Get the user the credentials belong to (who am I in Linear).",
    query: `query Viewer { viewer { ${USER} } }`,
    field: "viewer",
    input: z.object({}),
    output: user,
    effect: "read",
  }),
  "organization.get": graphqlAction({
    description: "Get the Linear workspace (organization) the credentials belong to.",
    query: "query Organization { organization { id name urlKey userCount } }",
    field: "organization",
    input: z.object({}),
    output: z.looseObject({ id: z.string(), name: z.string(), urlKey: z.string().optional(), userCount: z.number().optional() }),
    effect: "read",
  }),
  "teams.list": graphqlAction({
    description: "List the teams in the workspace. Returns one bounded page; pass nextCursor for more.",
    query: `query Teams($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { ${TEAM} } pageInfo { hasNextPage endCursor } } }`,
    field: "teams",
    connection: ["teams"],
    input: listing({}),
    output: z.array(team),
    effect: "read",
  }),
  "team.get": graphqlAction({
    description: "Get one team by id, with its key, name and description.",
    query: `query Team($id: String!) { team(id: $id) { ${TEAM} } }`,
    field: "team",
    input: z.object({ id }),
    output: team,
    effect: "read",
  }),
  "users.list": graphqlAction({
    description: "List the people in the workspace. Returns one bounded page; pass nextCursor for more.",
    query: `query Users($first: Int, $after: String, $filter: UserFilter) { users(first: $first, after: $after, filter: $filter) { nodes { ${USER} } pageInfo { hasNextPage endCursor } } }`,
    field: "users",
    connection: ["users"],
    input: listing({ filter: filterField }),
    output: z.array(user),
    effect: "read",
  }),
  "user.get": graphqlAction({
    description: "Get one person in the workspace by their id.",
    query: `query User($id: String!) { user(id: $id) { ${USER} } }`,
    field: "user",
    input: z.object({ id }),
    output: user,
    effect: "read",
  }),
  "issues.list": graphqlAction({
    description: "List issues, optionally filtered, newest updated first. Returns one bounded page; pass nextCursor for more.",
    query: `query Issues($first: Int, $after: String, $filter: IssueFilter, $includeArchived: Boolean) { issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived, orderBy: updatedAt) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`,
    field: "issues",
    connection: ["issues"],
    input: listing({ filter: filterField, includeArchived: z.boolean().optional() }),
    output: z.array(issue),
    effect: "read",
  }),
  "issue.get": graphqlAction({
    description: "Get one issue by id or identifier (such as ENG-123), with its state, assignee, project and labels.",
    query: `query Issue($id: String!) { issue(id: $id) { ${ISSUE} } }`,
    field: "issue",
    input: z.object({ id }),
    output: issue,
    effect: "read",
  }),
  "searchIssues.list": graphqlAction({
    description: "Search issues by text (title, description, comments). Returns one bounded page; pass nextCursor for more.",
    query: `query SearchIssues($term: String!, $first: Int, $after: String, $includeArchived: Boolean) { searchIssues(term: $term, first: $first, after: $after, includeArchived: $includeArchived) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`,
    field: "searchIssues",
    connection: ["searchIssues"],
    input: listing({ term: z.string().min(1), includeArchived: z.boolean().optional() }),
    output: z.array(issue),
    effect: "read",
  }),
  "issue.create": withInput(
    graphqlAction({
      description: "Create an issue in a team. Needs the team id and a title; the state, assignee, labels and project are optional.",
      query: `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`,
      field: "issueCreate",
      input: z.object({
        teamId: id,
        title: z.string().min(1),
        description: z.string().optional().describe("Markdown"),
        assigneeId: id.optional(),
        stateId: id.optional(),
        priority: z.number().int().min(0).max(4).optional(),
        labelIds: z.array(id).optional(),
        projectId: id.optional(),
        cycleId: id.optional(),
        parentId: id.optional(),
        dueDate: z.string().optional().describe("YYYY-MM-DD"),
      }),
      output: payload("issue", issue),
      effect: "write",
    }),
  ),
  "issue.update": withIdAndInput(
    graphqlAction({
      description: "Change an issue: title, description, state, assignee, priority, labels, project or due date. Only the fields you pass change.",
      query: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`,
      field: "issueUpdate",
      input: z.object({
        id,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        assigneeId: id.nullish(),
        stateId: id.optional(),
        priority: z.number().int().min(0).max(4).optional(),
        labelIds: z.array(id).optional().describe("The full list of labels; it replaces the current ones"),
        projectId: id.nullish(),
        cycleId: id.nullish(),
        dueDate: z.string().nullish().describe("YYYY-MM-DD, or null to clear"),
      }),
      output: payload("issue", issue),
      effect: "write",
    }),
  ),
  "issue.archive": graphqlAction({
    description: "Archive an issue (hides it from lists; it can be restored in Linear).",
    query: "mutation IssueArchive($id: String!) { issueArchive(id: $id) { success } }",
    field: "issueArchive",
    input: z.object({ id }),
    output: success,
    effect: "write",
  }),
  "issue.delete": graphqlAction({
    description: "Delete an issue: it moves to the trash and is permanently removed after the workspace's retention period.",
    query: "mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }",
    field: "issueDelete",
    input: z.object({ id }),
    output: success,
    effect: "destructive",
  }),
  "comments.list": graphqlAction({
    description: "List the comments on an issue. Returns one bounded page; pass nextCursor for more.",
    query: `query Comments($id: String!, $first: Int, $after: String) { issue(id: $id) { comments(first: $first, after: $after) { nodes { ${COMMENT} } pageInfo { hasNextPage endCursor } } } }`,
    field: "issue",
    connection: ["issue", "comments"],
    input: listing({ id }),
    output: z.array(comment),
    effect: "read",
  }),
  "comment.create": withInput(
    graphqlAction({
      description: "Add a comment to an issue. The body is Markdown. Pass parentId to reply in a thread.",
      query: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { ${COMMENT} } } }`,
      field: "commentCreate",
      input: z.object({ issueId: id, body: z.string().min(1), parentId: id.optional() }),
      output: payload("comment", comment),
      effect: "write",
    }),
  ),
  "projects.list": graphqlAction({
    description: "List projects, optionally filtered. Returns one bounded page; pass nextCursor for more.",
    query: `query Projects($first: Int, $after: String, $filter: ProjectFilter) { projects(first: $first, after: $after, filter: $filter) { nodes { ${PROJECT} } pageInfo { hasNextPage endCursor } } }`,
    field: "projects",
    connection: ["projects"],
    input: listing({ filter: filterField }),
    output: z.array(project),
    effect: "read",
  }),
  "project.get": graphqlAction({
    description: "Get one project by id, with its state, progress, lead and dates.",
    query: `query Project($id: String!) { project(id: $id) { ${PROJECT} } }`,
    field: "project",
    input: z.object({ id }),
    output: project,
    effect: "read",
  }),
  "project.create": withInput(
    graphqlAction({
      description: "Create a project for one or more teams.",
      query: `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { ${PROJECT} } } }`,
      field: "projectCreate",
      input: z.object({ name: z.string().min(1), teamIds: z.array(id).min(1), description: z.string().optional(), leadId: id.optional(), startDate: z.string().optional(), targetDate: z.string().optional() }),
      output: payload("project", project),
      effect: "write",
    }),
  ),
  "workflowStates.list": graphqlAction({
    description: "List workflow states (Backlog, In Progress, Done, ...). Filter by team to get the state ids an issue can move to.",
    query: `query WorkflowStates($first: Int, $after: String, $filter: WorkflowStateFilter) { workflowStates(first: $first, after: $after, filter: $filter) { nodes { id name type position team { id } } pageInfo { hasNextPage endCursor } } }`,
    field: "workflowStates",
    connection: ["workflowStates"],
    input: listing({ filter: filterField }),
    output: z.array(state),
    effect: "read",
  }),
  "issueLabels.list": graphqlAction({
    description: "List issue labels, optionally filtered. Returns one bounded page; pass nextCursor for more.",
    query: `query IssueLabels($first: Int, $after: String, $filter: IssueLabelFilter) { issueLabels(first: $first, after: $after, filter: $filter) { nodes { id name color team { id } } pageInfo { hasNextPage endCursor } } }`,
    field: "issueLabels",
    connection: ["issueLabels"],
    input: listing({ filter: filterField }),
    output: z.array(label),
    effect: "read",
  }),
  "cycles.list": graphqlAction({
    description: "List cycles (sprints), optionally filtered by team or dates. Returns one bounded page; pass nextCursor for more.",
    query: `query Cycles($first: Int, $after: String, $filter: CycleFilter) { cycles(first: $first, after: $after, filter: $filter) { nodes { id number name startsAt endsAt progress team { id } } pageInfo { hasNextPage endCursor } } }`,
    field: "cycles",
    connection: ["cycles"],
    input: listing({ filter: filterField }),
    output: z.array(cycle),
    effect: "read",
  }),
  "documents.list": graphqlAction({
    description: "List documents, optionally filtered. Returns one bounded page; pass nextCursor for more.",
    query: `query Documents($first: Int, $after: String, $filter: DocumentFilter) { documents(first: $first, after: $after, filter: $filter) { nodes { id title url updatedAt } pageInfo { hasNextPage endCursor } } }`,
    field: "documents",
    connection: ["documents"],
    input: listing({ filter: filterField }),
    output: z.array(document),
    effect: "read",
  }),
  "document.get": graphqlAction({
    description: "Get one document by id, with its Markdown content.",
    query: "query Document($id: String!) { document(id: $id) { id title content url updatedAt } }",
    field: "document",
    input: z.object({ id }),
    output: document,
    effect: "read",
  }),
} satisfies Record<string, ActionDefinition>

export const linear = defineConnector({
  name: "linear",
  baseUrl: "https://api.linear.app",
  auth: {
    type: "oauth2",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopeSeparator: ",",
    pkce: true,
    rawTokenPattern: "^lin_api_",
  },
  detectError: (body) => detectGraphqlError(body),
  // Linear reports rate limiting as HTTP 400 (not 429). X-RateLimit-Requests-Reset is when the budget refills, in epoch milliseconds.
  detectHttpError: ({ status, headers, body }) => {
    const code = (body as { errors?: Array<{ extensions?: { code?: unknown } }> } | undefined)?.errors?.[0]?.extensions?.code
    if (status !== 400 || code !== "RATELIMITED") return undefined
    const reset = Number(headers.get("x-ratelimit-requests-reset"))
    const retryAfter = Number.isFinite(reset) && reset > 0 ? Math.min(3600, Math.max(1, Math.ceil((reset - Date.now()) / 1000))) : undefined
    return new ConnectorKitError("rate_limited", "The provider rate limit was hit. Retry later.", { retryable: true, status, ...(retryAfter !== undefined && { retryAfter }) })
  },
  meta: {
    title: "Linear",
    description: "Search, read, create and update issues, comments, projects, cycles and documents in Linear, over its GraphQL API.",
    docsUrl: "https://linear.app/developers",
    status: "docs-based",
    credentialEnv: "LINEAR_API_KEY",
  },
  actions,
})

export default linear
