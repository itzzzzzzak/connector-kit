// Shared by the Google Workspace connectors (ADR-022): one OAuth setup, one error reading.
import type { AuthConfig } from "./define.js"

/**
 * Google's OAuth 2.0 endpoints. `access_type=offline` and `prompt=consent` are what make Google hand out a refresh token (it
 * otherwise does so only the first time a user consents). `include_granted_scopes` lets a user who connected Gmail add Calendar later
 * without losing the first grant. Access tokens last one hour.
 */
export function googleAuth(scopes: string[]): AuthConfig {
  return {
    type: "oauth2",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes,
    pkce: true,
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  }
}
