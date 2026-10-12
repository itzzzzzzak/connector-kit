import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { generatedActions } from "./generated/index.js"

export const googleForms = defineConnector({
  name: "google-forms",
  baseUrl: "https://forms.googleapis.com/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/forms.body", "https://www.googleapis.com/auth/forms.responses.readonly"]),
  meta: {
    title: "Google Forms",
    description: "Create and edit Google Forms and read their responses.",
    docsUrl: "https://developers.google.com/workspace/forms/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_FORMS_TOKEN",
  },
  actions: {
    ...generatedActions,
  },
})

export default googleForms
