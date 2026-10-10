// A tiny web app that lets a user "Connect GitHub" with OAuth, then calls GitHub as them.
//
//   1. Create a GitHub OAuth App (Settings > Developer settings > OAuth Apps) with the callback URL
//      http://localhost:3000/callback
//   2. pnpm build
//   3. GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... node examples/oauth-server.ts
//   4. Open http://localhost:3000/connect
//
// DEMO ONLY: there is a single hard-coded user. In a real app, "demo-user" is your logged-in user's id,
// and /callback must run in that user's session (pass it as expectedConnectionId).
import { createServer } from "node:http"
import { createConnectorKit, createEncryption, encryptedStore, generateEncryptionKey, memoryTokenStore } from "connector-kit"
import { github } from "connector-kit/github"

const clientId = process.env.GITHUB_CLIENT_ID
const clientSecret = process.env.GITHUB_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (see the comment at the top of this file).")
  process.exit(1)
}

const PORT = 3000
const USER = "demo-user"

// In production: a Postgres/Redis store, and an encryption key from your secret manager (NOT next to the data).
const key = process.env.CONNECTOR_KIT_ENCRYPTION_KEY ?? generateEncryptionKey()
const kit = createConnectorKit({
  tokenStore: encryptedStore(memoryTokenStore(), createEncryption({ current: "k1", keys: { k1: key } })),
  oauth: { github: { clientId, clientSecret, redirectUri: `http://localhost:${PORT}/callback` } },
})

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  const text = (status: number, body: string) => (res.writeHead(status, { "content-type": "text/plain" }), res.end(body))
  try {
    if (url.pathname === "/connect") {
      const { url: authorizeUrl } = await kit.startAuth(github, { connectionId: USER }) // add scopes: ["repo"] for private repos
      res.writeHead(302, { location: authorizeUrl })
      return res.end()
    }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) return text(400, "Missing code or state")
      await kit.finishAuth(github, { code, state, expectedConnectionId: USER })
      return text(200, "Connected! Now open /repo")
    }
    if (url.pathname === "/repo") {
      const gh = kit.connect(github, { connectionId: USER }) // no credentials: uses the stored, auto-refreshed token
      const repo = await gh.execute("repos.get", { owner: "octocat", name: "Hello-World" })
      return text(200, `${repo.full_name}: ${repo.stargazers_count} stars (fetched with your OAuth token)`)
    }
    return text(200, "Open /connect, authorize on GitHub, then open /repo")
  } catch (error) {
    // ConnectorKitError messages are safe to show; they never contain tokens.
    const e = error as { code?: string; message?: string }
    return text(e.code === "not_connected" ? 401 : 500, `${e.code ?? "error"}: ${e.message ?? "unknown"}`)
  }
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/connect`))
