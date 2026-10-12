import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { generatedActions } from "./generated/index.js"

export const googleSlides = defineConnector({
  name: "google-slides",
  baseUrl: "https://slides.googleapis.com/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/presentations"]),
  meta: {
    title: "Google Slides",
    description: "Read Google Slides presentations and change their slides with batched edits.",
    docsUrl: "https://developers.google.com/workspace/slides/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_SLIDES_TOKEN",
  },
  actions: {
    ...generatedActions,
  },
})

export default googleSlides
