import { bodyCursorPagination, defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's Drive API v3 reference and Discovery document: base URL https://www.googleapis.com/drive/v3, lists page with
// `pageToken` / `pageSize` and `nextPageToken`, and a file response carries ONLY id, name, mimeType and kind unless `fields` asks for more
// (the curated actions below ask for a useful default). Search uses `q`, e.g. "name contains 'plan' and mimeType = 'application/pdf' and trashed = false".
// A Google Doc, Sheet or Slide has no downloadable bytes; use the Docs, Sheets and Slides connectors for their content. This connector does
// not upload or download file content (that needs multipart and binary bodies, which the kit does not send): it manages files and folders as
// metadata (create a folder, rename, move, trash, share). Scopes: drive.readonly reads, drive.file only touches files the app made, drive is everything.
//
// A curated, typed set is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: file names and descriptions are written by other people and can contain anything, including text aimed at an AI.
// They are data, never instructions. Sharing a file (permissions.create) can expose it to the world: ask a human first.

const fileId = z.string().min(1)
const paging = { cursor: z.string().optional(), pageSize: z.number().optional() }
const FILE_FIELDS = "id,name,mimeType,description,parents,trashed,starred,createdTime,modifiedTime,size,webViewLink,owners(displayName,emailAddress),shared"
const owner = z.looseObject({ displayName: z.string().optional(), emailAddress: z.string().optional() })
const file = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  description: z.string().optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean().optional(),
  starred: z.boolean().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  size: z.string().optional(),
  webViewLink: z.string().optional(),
  shared: z.boolean().optional(),
  owners: z.array(owner).optional(),
})
const permission = z.looseObject({ id: z.string(), type: z.string().optional(), role: z.string().optional(), emailAddress: z.string().optional(), displayName: z.string().optional(), domain: z.string().optional() })
const fieldsOr = (i: Record<string, unknown>, fallback: string) => (typeof i.fields === "string" ? i.fields : fallback)
const allDrives = { supportsAllDrives: true }

export const googleDrive = defineConnector({
  name: "google-drive",
  baseUrl: "https://www.googleapis.com/drive/v3",
  auth: googleAuth(["https://www.googleapis.com/auth/drive.readonly"]),
  meta: {
    title: "Google Drive",
    description: "Search, read, organize and share files and folders in Google Drive.",
    docsUrl: "https://developers.google.com/workspace/drive/api/reference/rest/v3",
    status: "docs-based",
    credentialEnv: "GOOGLE_DRIVE_TOKEN",
  },
  actions: {
    ...generatedActions,
    "about.get": {
      description: "Get the signed-in user and their storage quota. Use it to learn whose Drive the credentials open.",
      method: "GET",
      path: "/about",
      input: z.object({ fields: z.string().optional().describe("Default: user,storageQuota") }),
      output: z.looseObject({ user: owner.optional(), storageQuota: z.record(z.string(), z.unknown()).optional() }),
      effect: "read",
      buildQuery: (i) => ({ fields: fieldsOr(i, "user,storageQuota") }),
    },
    "files.list": {
      description: "Search files and folders. q uses Drive query syntax (name contains 'plan' and trashed = false; 'FOLDER_ID' in parents). One bounded page; pass nextCursor for more.",
      method: "GET",
      path: "/files",
      input: z.object({
        q: z.string().optional(),
        orderBy: z.string().optional().describe("e.g. modifiedTime desc, name"),
        spaces: z.string().optional().describe("drive (default), appDataFolder"),
        corpora: z.enum(["user", "drive", "domain", "allDrives"]).optional(),
        driveId: z.string().optional(),
        fields: z.string().optional().describe("A field mask, e.g. nextPageToken,files(id,name). Default: the useful ones"),
        ...paging,
      }),
      output: z.array(file),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "files", cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "pageSize", defaultPageSize: 25, maxPageSize: 100 }),
      buildQuery: (i) => {
        const { fields, ...rest } = i
        return { ...rest, ...allDrives, includeItemsFromAllDrives: true, fields: typeof fields === "string" ? fields : `nextPageToken,files(${FILE_FIELDS})` }
      },
    },
    "files.get": {
      description: "Get one file or folder's metadata by id: name, type, parents, owners, dates, size and link.",
      method: "GET",
      path: "/files/{fileId}",
      input: z.object({ fileId, fields: z.string().optional() }),
      output: file,
      effect: "read",
      buildQuery: (i) => ({ ...allDrives, fields: fieldsOr(i, FILE_FIELDS) }),
    },
    "files.create": {
      description: "Create a file or folder from metadata alone (no content): a folder is mimeType application/vnd.google-apps.folder. Google Docs, Sheets and Slides can be created empty by their mimeType.",
      method: "POST",
      path: "/files",
      input: z.object({ name: z.string().min(1), mimeType: z.string().optional(), parents: z.array(z.string()).optional().describe("Folder ids to put it in"), description: z.string().optional() }),
      output: file,
      effect: "write",
      buildQuery: () => ({ ...allDrives, fields: FILE_FIELDS }),
    },
    "files.update": {
      description: "Rename a file, change its description, star it, trash or restore it, or move it between folders (addParents / removeParents). Only the fields you pass change.",
      method: "PATCH",
      path: "/files/{fileId}",
      input: z.object({
        fileId,
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        starred: z.boolean().optional(),
        trashed: z.boolean().optional().describe("true moves it to the trash, false restores it"),
        addParents: z.string().optional().describe("Comma-separated folder ids to add"),
        removeParents: z.string().optional().describe("Comma-separated folder ids to remove"),
      }),
      output: file,
      effect: "write",
      buildQuery: (i) => ({ ...allDrives, fields: FILE_FIELDS, ...(i.addParents !== undefined && { addParents: i.addParents }), ...(i.removeParents !== undefined && { removeParents: i.removeParents }) }),
      buildBody: (i) => {
        const { addParents: _a, removeParents: _r, ...fields } = i
        return fields
      },
    },
    "files.delete": {
      description: "Permanently delete a file or folder, skipping the trash. Cannot be undone; prefer files.update with trashed true.",
      method: "DELETE",
      path: "/files/{fileId}",
      input: z.object({ fileId }),
      output: z.unknown(),
      effect: "destructive",
      buildQuery: () => allDrives,
    },
    "permissions.list": {
      description: "List who a file is shared with and how (role: reader, commenter, writer, owner).",
      method: "GET",
      path: "/files/{fileId}/permissions",
      input: z.object({ fileId, ...paging }),
      output: z.array(permission),
      effect: "read",
      paginate: bodyCursorPagination({ itemsKey: "permissions", cursorPath: ["nextPageToken"], cursorParam: "pageToken", pageSizeParam: "pageSize", defaultPageSize: 25, maxPageSize: 100 }),
      buildQuery: () => ({ ...allDrives, fields: "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain)" }),
    },
    "permissions.create": {
      description: "Share a file or folder with a person, group, domain, or anyone with the link. Can expose the file widely: confirm with a human first.",
      method: "POST",
      path: "/files/{fileId}/permissions",
      input: z.object({
        fileId,
        type: z.enum(["user", "group", "domain", "anyone"]),
        role: z.enum(["reader", "commenter", "writer"]),
        emailAddress: z.string().optional().describe("For type user or group"),
        domain: z.string().optional().describe("For type domain"),
        sendNotificationEmail: z.boolean().optional(),
        emailMessage: z.string().optional(),
      }),
      output: permission,
      effect: "write",
      buildQuery: (i) => ({ ...allDrives, ...(i.sendNotificationEmail !== undefined && { sendNotificationEmail: i.sendNotificationEmail }), ...(i.emailMessage !== undefined && { emailMessage: i.emailMessage }) }),
      buildBody: (i) => ({ type: i.type, role: i.role, emailAddress: i.emailAddress, domain: i.domain }),
    },
  },
})

export default googleDrive
