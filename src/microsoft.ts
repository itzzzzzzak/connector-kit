// Shared by the Microsoft 365 connectors (ADR-026): one OAuth setup, one way to read Microsoft Graph's paging.
import { bodyLinkPagination } from "./pagination.js"
import type { AuthConfig } from "./define.js"

/**
 * Microsoft identity platform (v2.0) OAuth. The "common" tenant lets work, school and personal accounts sign in; an app registered for
 * one tenant only must be used with that tenant's endpoints, which the kit cannot template yet (auth URLs take no placeholders).
 * `offline_access` is what makes Microsoft return a refresh token. Access tokens last about an hour.
 */
export function microsoftAuth(scopes: string[]): AuthConfig {
  return {
    type: "oauth2",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [...scopes, "offline_access"],
    pkce: true,
  }
}

/**
 * Microsoft Graph lists put the page in `value` and the FULL URL of the next page in `@odata.nextLink`. The link already carries the
 * query (including $top and any filter), so the URL itself is the cursor. A link to another host is refused by the base-URL check.
 */
export const graphPage = (options: { defaultPageSize?: number; maxPageSize?: number } = {}) =>
  bodyLinkPagination({ itemsKey: "value", nextUrlPath: ["@odata.nextLink"], pageSizeParam: "$top", defaultPageSize: options.defaultPageSize ?? 25, maxPageSize: options.maxPageSize ?? 100 })
