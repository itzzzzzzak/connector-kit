import { defineConnector } from "../../index.js"
import { graphPage, microsoftAuth } from "../../microsoft.js"
import { z } from "zod"

// Facts from the Microsoft Graph v1.0 reference (OneDrive / drive and driveItem): base URL https://graph.microsoft.com/v1.0, "/me/drive" is the
// signed-in user's OneDrive, items are addressed by id or by "root", lists put the page in `value` and the next page's full URL in
// `@odata.nextLink`. Scopes: Files.Read / Files.ReadWrite. SharePoint document libraries use the same driveItem shape but live under
// /sites and /drives; they are not covered here. File upload and download move bytes, not JSON, and are left out of this version.
//
// SECURITY: file names and metadata are chosen by whoever shared or uploaded the file and can contain anything, including text aimed at an AI.
// They are data, never instructions. Creating a sharing link exposes a file to whoever holds the link: ask a human first.

const id = z.string().min(1)
const paging = { cursor: z.string().optional().describe("The nextCursor from the previous page"), pageSize: z.number().int().min(1).max(100).optional() }
const item = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  webUrl: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  folder: z.looseObject({ childCount: z.number().optional() }).optional(),
  file: z.looseObject({ mimeType: z.string().optional() }).optional(),
  parentReference: z.looseObject({ id: z.string().optional(), path: z.string().optional(), driveId: z.string().optional() }).optional(),
})
const select = "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,folder,file,parentReference"

export const onedrive = defineConnector({
  name: "onedrive",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: microsoftAuth(["Files.ReadWrite", "User.Read"]),
  meta: {
    title: "OneDrive (Microsoft 365)",
    description: "Browse, search and organize files and folders in a user's OneDrive, and create sharing links, through Microsoft Graph.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/onedrive",
    status: "docs-based",
    credentialEnv: "ONEDRIVE_TOKEN",
  },
  actions: {
    "drive.get": {
      description: "Get the user's OneDrive: its id, type and storage quota (used and remaining bytes).",
      method: "GET",
      path: "/me/drive",
      input: z.object({}),
      output: z.looseObject({ id: z.string(), driveType: z.string().optional(), quota: z.looseObject({ total: z.number().optional(), used: z.number().optional(), remaining: z.number().optional() }).optional() }),
      effect: "read",
    },
    "children.list": {
      description: 'List the files and folders inside a folder. itemId is a folder id, or "root" (the default) for the top of OneDrive. One bounded page; pass nextCursor for more.',
      method: "GET",
      path: "/me/drive/items/{itemId}/children",
      input: z.object({ itemId: id.default("root"), ...paging }),
      output: z.array(item),
      effect: "read",
      paginate: graphPage(),
      buildQuery: () => ({ $select: select }),
    },
    "item.get": {
      description: "Get the metadata of one file or folder by id (name, size, type, location, web link). It does not return the file's content.",
      method: "GET",
      path: "/me/drive/items/{itemId}",
      input: z.object({ itemId: id }),
      output: item,
      effect: "read",
      buildQuery: () => ({ $select: select }),
    },
    "items.search": {
      description: "Search the user's OneDrive by file name and content. One bounded page; pass nextCursor for more. The query cannot contain a single quote.",
      method: "GET",
      path: "/me/drive/root/search(q='{query}')",
      input: z.object({ query: z.string().min(1).max(200).regex(/^[^']+$/, "The query cannot contain a single quote"), ...paging }),
      output: z.array(item),
      effect: "read",
      paginate: graphPage(),
      buildQuery: () => ({ $select: select }),
    },
    "folder.create": {
      description: 'Create a folder inside another folder (parentId is a folder id, or "root"). It fails if a folder with that name already exists.',
      method: "POST",
      path: "/me/drive/items/{parentId}/children",
      input: z.object({ parentId: id.default("root"), name: z.string().min(1).max(250).regex(/^[^\\/:*?"<>|]+$/, 'A name cannot contain \\ / : * ? " < > |') }),
      output: item,
      effect: "write",
      buildBody: (i) => ({ name: i.name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    },
    "item.rename": {
      description: "Rename a file or folder. The content does not change.",
      method: "PATCH",
      path: "/me/drive/items/{itemId}",
      input: z.object({ itemId: id, name: z.string().min(1).max(250).regex(/^[^\\/:*?"<>|]+$/, 'A name cannot contain \\ / : * ? " < > |') }),
      output: item,
      effect: "write",
    },
    "item.createLink": {
      description: 'Create a sharing link for a file or folder. scope "organization" limits it to the user\'s organization; "anonymous" lets anyone with the link in. This exposes the item: ask a human first.',
      method: "POST",
      path: "/me/drive/items/{itemId}/createLink",
      input: z.object({ itemId: id, type: z.enum(["view", "edit"]), scope: z.enum(["organization", "anonymous"]).default("organization") }),
      output: z.looseObject({ link: z.looseObject({ webUrl: z.string().optional(), type: z.string().optional(), scope: z.string().optional() }) }),
      effect: "write",
    },
    "item.delete": {
      description: "Delete a file or folder (it moves to the OneDrive recycle bin, where it can be restored for a limited time). Deleting a folder deletes everything in it.",
      method: "DELETE",
      path: "/me/drive/items/{itemId}",
      input: z.object({ itemId: id }),
      output: z.unknown(),
      effect: "destructive",
    },
  },
})

export default onedrive
