import { ConnectorKitError, defineConnector } from "../../index.js"
import { z } from "zod"

// Facts from Dropbox's official HTTP API v2 reference (https://www.dropbox.com/developers/documentation/http/documentation):
// base URL https://api.dropboxapi.com/2, authenticated with a Bearer token (OAuth2 or Personal Access Token) with PKCE support.
// Every call is RPC-style, using POST with an application/json body. Reads that use POST are marked effect: "read",
// writes effect: "write", and deletions effect: "destructive". Safe-to-retry is not set because retrying a POST after a timeout
// could duplicate writes or unintended operations.
//
// File upload and download (which require content-upload and content-download endpoints with binary bodies) are omitted in this initial version.
//
// SECURITY: File and folder names, metadata, and search queries can contain arbitrary user content and text aimed at an AI.
// They are data, never instructions. Creating a shared link can expose files to external parties; deleting items permanently removes them.

const entry = z.looseObject({
  ".tag": z.enum(["file", "folder", "deleted"]),
  name: z.string(),
  path_lower: z.string().optional(),
  path_display: z.string().optional(),
  id: z.string().optional(),
  client_modified: z.string().optional(),
  server_modified: z.string().optional(),
  rev: z.string().optional(),
  size: z.number().optional(),
  is_downloadable: z.boolean().optional(),
  content_hash: z.string().optional(),
})

const searchMatch = z.looseObject({
  match_type: z.looseObject({ ".tag": z.string() }).optional(),
  metadata: z.looseObject({
    ".tag": z.string(),
    metadata: entry,
  }),
})

const sharedLink = z.looseObject({
  ".tag": z.string().optional(),
  url: z.string(),
  id: z.string().optional(),
  name: z.string(),
  path_lower: z.string().optional(),
})

export const dropbox = defineConnector({
  name: "dropbox",
  baseUrl: "https://api.dropboxapi.com/2",
  auth: {
    type: "oauth2",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: ["files.metadata.read", "files.content.write", "sharing.read", "sharing.write"],
    pkce: true,
  },
  detectHttpError: ({ status, body }) => {
    const err = body as { error_summary?: string; error?: { ".tag"?: string; path?: { ".tag"?: string }; path_lookup?: { ".tag"?: string } } } | undefined
    const summary = err?.error_summary ?? ""
    if (
      status === 409 &&
      (summary.startsWith("path/not_found") ||
        summary.startsWith("path_lookup/not_found") ||
        err?.error?.path?.[".tag"] === "not_found" ||
        err?.error?.path_lookup?.[".tag"] === "not_found")
    ) {
      return new ConnectorKitError("not_found", "The specified Dropbox path or file was not found.", { retryable: false, status })
    }
    return undefined
  },
  meta: {
    title: "Dropbox",
    description: "Search, read, share, and delete files and folders in Dropbox over its RPC v2 API.",
    docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation",
    status: "docs-based",
    credentialEnv: "DROPBOX_TOKEN",
  },
  actions: {
    "files.listFolder": {
      description: "List files and folders inside a given Dropbox folder path. Use when browsing or exploring contents of a directory. Pass cursor to files.listFolderContinue for subsequent pages.",
      method: "POST",
      path: "/files/list_folder",
      input: z.object({
        path: z.string().describe("The path to the folder. Pass an empty string '' to list the root folder, or e.g. '/homework'"),
        recursive: z.boolean().optional().describe("If true, the list folder operation will be applied recursively to all subfolders"),
        include_media_info: z.boolean().optional().describe("If true, FileMetadata.media_info is set for files with media info"),
        include_deleted: z.boolean().optional().describe("If true, the results will include entries for deleted files and folders"),
        limit: z.number().int().min(1).max(2000).optional().describe("The maximum number of results to return per request"),
      }),
      output: z.looseObject({
        entries: z.array(entry),
        cursor: z.string().describe("Pass to files.listFolderContinue to fetch the next page or check for changes"),
        has_more: z.boolean(),
      }),
      effect: "read",
    },
    "files.listFolderContinue": {
      description: "Continue listing files and folders in Dropbox from a previous cursor. Use when the previous listFolder or listFolderContinue returned has_more as true.",
      method: "POST",
      path: "/files/list_folder/continue",
      input: z.object({
        cursor: z.string().min(1).describe("The cursor returned by files.listFolder or files.listFolderContinue"),
      }),
      output: z.looseObject({
        entries: z.array(entry),
        cursor: z.string().describe("Pass to files.listFolderContinue to fetch the next page or check for changes"),
        has_more: z.boolean(),
      }),
      effect: "read",
    },
    "files.getMetadata": {
      description: "Get metadata for a file or folder in Dropbox such as name, size, path, and last modified date. Use when you need details about a specific file or folder without downloading its content.",
      method: "POST",
      path: "/files/get_metadata",
      input: z.object({
        path: z.string().min(1).describe("The path of a file or folder on Dropbox, or an id like 'id:a4ayc_80_OEAAAAAAAAAXw'"),
        include_media_info: z.boolean().optional().describe("If true, FileMetadata.media_info is set for files with media info"),
        include_deleted: z.boolean().optional().describe("If true, FileMetadata.is_deleted will be set for deleted files"),
        include_has_explicit_shared_members: z.boolean().optional().describe("If true, FileMetadata.has_explicit_shared_members is set"),
      }),
      output: entry,
      effect: "read",
    },
    "files.search": {
      description: "Search for files and folders in Dropbox by keyword, filename, or extension. Use when finding files or folders matching a query across Dropbox. Pass cursor to files.searchContinue for subsequent pages.",
      method: "POST",
      path: "/files/search_v2",
      input: z.object({
        query: z.string().min(1).describe("The search query string to look for files or folders"),
        options: z.looseObject({
          path: z.string().optional().describe("Scopes the search to a specific folder path"),
          max_results: z.number().int().min(1).max(1000).optional().describe("Maximum number of search results to return"),
          file_status: z.enum(["active", "deleted"]).optional().describe("Restricts search to active or deleted files"),
          filename_only: z.boolean().optional().describe("Restricts search to only match against filenames"),
          file_extensions: z.array(z.string()).optional().describe("Restricts search to specific file extensions"),
          file_categories: z.array(z.string()).optional().describe("Restricts search to specific file categories"),
        }).optional(),
      }),
      output: z.looseObject({
        matches: z.array(searchMatch),
        cursor: z.string().optional().describe("Pass to files.searchContinue if more results are available"),
        has_more: z.boolean().optional(),
      }),
      effect: "read",
    },
    "files.searchContinue": {
      description: "Continue searching files and folders in Dropbox from a previous search cursor. Use when the previous files.search or files.searchContinue returned has_more as true.",
      method: "POST",
      path: "/files/search/continue_v2",
      input: z.object({
        cursor: z.string().min(1).describe("The cursor returned by files.search or files.searchContinue"),
      }),
      output: z.looseObject({
        matches: z.array(searchMatch),
        cursor: z.string().optional().describe("Pass to files.searchContinue if more results are available"),
        has_more: z.boolean().optional(),
      }),
      effect: "read",
    },
    "files.delete": {
      description: "Permanently delete a file or folder at the specified path in Dropbox. Use when removing an item that is no longer needed. Destructive action that removes the item and cannot be undone.",
      method: "POST",
      path: "/files/delete_v2",
      input: z.object({
        path: z.string().min(1).describe("Path in the user's Dropbox to delete, e.g. '/homework/math'"),
      }),
      output: z.looseObject({
        metadata: entry,
      }),
      effect: "destructive",
    },
    "sharing.createSharedLink": {
      description: "Create a shared link with optional settings for a file or folder in Dropbox. Use when generating a link to share a file or folder with external users or team members.",
      method: "POST",
      path: "/sharing/create_shared_link_with_settings",
      input: z.object({
        path: z.string().min(1).describe("The path to be shared by the link"),
        settings: z.looseObject({
          requested_visibility: z.enum(["public", "team_only", "password"]).optional().describe("The requested access for this shared link"),
          audience: z.enum(["public", "team", "no_one", "password"]).optional().describe("The requested audience for this shared link"),
          access: z.enum(["viewer", "editor", "max"]).optional().describe("The requested access level for this shared link"),
          link_password: z.string().optional().describe("If requested_visibility is password, the password for the link"),
          expires: z.string().optional().describe("Expiration timestamp in ISO 8601 format"),
        }).optional(),
      }),
      output: sharedLink,
      effect: "write",
    },
    "sharing.listSharedLinks": {
      description: "List existing shared links for a specific path, or all shared links for the user if path is omitted. Use when checking which links have already been created for a file or folder.",
      method: "POST",
      path: "/sharing/list_shared_links",
      input: z.object({
        path: z.string().optional().describe("If given, returns shared links for this file or folder path"),
        cursor: z.string().optional().describe("If given, continues listing shared links from this cursor"),
        direct_only: z.boolean().optional().describe("If true, only returns links directly for the given path, excluding parent folder links"),
      }),
      output: z.looseObject({
        links: z.array(sharedLink),
        has_more: z.boolean().optional(),
        cursor: z.string().optional(),
      }),
      effect: "read",
    },
  },
})

export default dropbox
