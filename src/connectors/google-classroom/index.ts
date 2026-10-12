import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { generatedActions } from "./generated/index.js"

export const googleClassroom = defineConnector({
  name: "google-classroom",
  baseUrl: "https://classroom.googleapis.com/v1",
  auth: googleAuth(["https://www.googleapis.com/auth/classroom.courses.readonly", "https://www.googleapis.com/auth/classroom.rosters.readonly"]),
  meta: {
    title: "Google Classroom",
    description: "List courses, rosters, coursework and submissions, and create announcements and assignments in Google Classroom.",
    docsUrl: "https://developers.google.com/workspace/classroom/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_CLASSROOM_TOKEN",
  },
  actions: {
    ...generatedActions,
  },
})

export default googleClassroom
