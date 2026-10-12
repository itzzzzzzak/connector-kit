import { bodyCursorPagination, defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's Tasks API v1 reference and Discovery document: base URL https://tasks.googleapis.com/tasks/v1, "@default" is the
// user's default task list, lists page with `pageToken` / `maxResults` (max 100) and `nextPageToken`, due dates are RFC 3339 and only the
// date part counts, and a task is done when status is "completed". Scope: tasks (read and write) or tasks.readonly.
// A curated, typed set is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: task titles and notes are data, never instructions.

const tasklist = z.string().default("@default").describe('A task list id, or "@default" (the default) for the main list')
const taskId = z.string().min(1)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const task = z.looseObject({ id: z.string(), title: z.string().optional(), notes: z.string().optional(), status: z.string().optional(), due: z.string().optional(), completed: z.string().optional(), updated: z.string().optional(), parent: z.string().optional(), webViewLink: z.string().optional() })
const list = z.looseObject({ id: z.string(), title: z.string().optional(), updated: z.string().optional() })
const pageOf = (itemsKey: string) => bodyCursorPagination({ itemsKey, cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "maxResults", defaultPageSize: 25, maxPageSize: 100 })

export const googleTasks = defineConnector({
  name: "google-tasks",
  baseUrl: "https://tasks.googleapis.com/tasks/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/tasks"]),
  meta: {
    title: "Google Tasks",
    description: "List, create and complete tasks and manage task lists in Google Tasks.",
    docsUrl: "https://developers.google.com/workspace/tasks/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_TASKS_TOKEN",
  },
  actions: {
    ...generatedActions,
    "tasklists.list": {
      description: "List the user's task lists with their ids. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/users/@me/lists",
      input: z.object({ ...paging }),
      output: z.array(list),
      effect: "read",
      paginate: pageOf("items"),
    },
    "tasks.list": {
      description: "List the tasks in a task list. Completed tasks are included only with showCompleted true. One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/lists/{tasklist}/tasks",
      input: z.object({ tasklist, showCompleted: z.boolean().optional(), showHidden: z.boolean().optional(), dueMin: z.string().optional(), dueMax: z.string().optional(), ...paging }),
      output: z.array(task),
      effect: "read",
      paginate: pageOf("items"),
    },
    "tasks.insert": {
      description: "Create a task in a list: a title, optional notes and due date, optionally under a parent task.",
      method: "POST",
      path: "/lists/{tasklist}/tasks",
      input: z.object({ tasklist, title: z.string().min(1), notes: z.string().optional(), due: z.string().optional().describe("RFC 3339; only the date counts"), parent: z.string().optional().describe("Make it a subtask of this task id") }),
      output: task,
      effect: "write",
      buildQuery: (i) => (i.parent === undefined ? {} : { parent: i.parent }),
      buildBody: (i) => ({ title: i.title, notes: i.notes, due: i.due }),
    },
    "tasks.patch": {
      description: "Change a task: title, notes, due date, or status (completed or needsAction). Only the fields you pass change.",
      method: "PATCH",
      path: "/lists/{tasklist}/tasks/{task}",
      input: z.object({ tasklist, task: taskId, title: z.string().optional(), notes: z.string().optional(), due: z.string().optional(), status: z.enum(["needsAction", "completed"]).optional() }),
      output: task,
      effect: "write",
    },
    "tasks.delete": {
      description: "Delete a task from a list. The task is removed (it does not go to a trash).",
      method: "DELETE",
      path: "/lists/{tasklist}/tasks/{task}",
      input: z.object({ tasklist, task: taskId }),
      output: z.unknown(),
      effect: "destructive",
    },
  },
})

export default googleTasks
