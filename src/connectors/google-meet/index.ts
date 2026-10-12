import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { generatedActions } from "./generated/index.js"

export const googleMeet = defineConnector({
  name: "google-meet",
  baseUrl: "https://meet.googleapis.com/v2",
  auth: googleAuth(["https://www.googleapis.com/auth/meetings.space.created"]),
  meta: {
    title: "Google Meet",
    description: "Create and manage Google Meet meeting spaces and read conference records, participants and transcripts.",
    docsUrl: "https://developers.google.com/workspace/meet/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_MEET_TOKEN",
  },
  actions: {
    ...generatedActions,
  },
})

export default googleMeet
