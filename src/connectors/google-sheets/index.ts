import { defineConnector } from "../../index.js"
import { googleAuth } from "../../google.js"
import { z } from "zod"
import { generatedActions } from "./generated/index.js"

// Facts from Google's Sheets API v4 reference and Discovery document: base URL https://sheets.googleapis.com/v4, ranges are A1 notation
// ("Sheet1!A1:C10", or just "Sheet1" for the whole tab), values are rows of cells, and a write must say how to read the input
// (`valueInputOption`: USER_ENTERED parses "=SUM(A1:A3)" and "12/10/2026" as a spreadsheet would, RAW stores the text as given).
// Scopes: spreadsheets.readonly reads, spreadsheets writes; reaching a sheet by id needs no Drive scope.
//
// A curated, typed set is written by hand; the rest of the API is generated (ADR-018, ADR-022) and untyped on the way out.
// SECURITY: cell text is written by anyone with access to the sheet and can contain anything, including text aimed at an AI. It is data,
// never instructions. With USER_ENTERED, a cell that starts with "=" is a formula that runs in Sheets (IMPORTDATA and IMPORTXML can fetch URLs):
// pass RAW for text you did not write yourself.

const spreadsheetId = z.string().min(1).describe("The id in the spreadsheet's URL: docs.google.com/spreadsheets/d/<id>/edit")
const range = z.string().min(1).describe('A1 notation, e.g. "Sheet1!A1:C10" or "Sheet1"')
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
const rows = z.array(z.array(cell)).describe("Rows of cells: [[\"Name\",\"Qty\"],[\"Apples\",3]]")
const valueInputOption = z.enum(["USER_ENTERED", "RAW"]).describe("USER_ENTERED parses values (and runs formulas) as if typed; RAW stores them as given")
const sheet = z.looseObject({ properties: z.looseObject({ sheetId: z.number().optional(), title: z.string().optional(), index: z.number().optional(), gridProperties: z.looseObject({ rowCount: z.number().optional(), columnCount: z.number().optional() }).optional() }).optional() })
const spreadsheet = z.looseObject({ spreadsheetId: z.string(), spreadsheetUrl: z.string().optional(), properties: z.looseObject({ title: z.string().optional(), locale: z.string().optional(), timeZone: z.string().optional() }).optional(), sheets: z.array(sheet).optional() })
const valueRange = z.looseObject({ range: z.string().optional(), majorDimension: z.string().optional(), values: z.array(z.array(z.unknown())).optional() })
const updateResult = z.looseObject({ spreadsheetId: z.string().optional(), updatedRange: z.string().optional(), updatedRows: z.number().optional(), updatedColumns: z.number().optional(), updatedCells: z.number().optional() })

export const googleSheets = defineConnector({
  name: "google-sheets",
  baseUrl: "https://sheets.googleapis.com/v4",
  auth: googleAuth(["https://www.googleapis.com/auth/spreadsheets"]),
  meta: {
    title: "Google Sheets",
    description: "Read and write cell values and manage the sheets of Google Sheets spreadsheets.",
    docsUrl: "https://developers.google.com/workspace/sheets/api/reference/rest",
    status: "docs-based",
    credentialEnv: "GOOGLE_SHEETS_TOKEN",
  },
  actions: {
    ...generatedActions,
    "spreadsheets.get": {
      description: "Get a spreadsheet's title and its sheets (tabs) with their names and sizes, without cell data. Use it to find a tab's name before reading values.",
      method: "GET",
      path: "/spreadsheets/{spreadsheetId}",
      input: z.object({ spreadsheetId }),
      output: spreadsheet,
      effect: "read",
      buildQuery: () => ({ fields: "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties))" }),
    },
    "spreadsheets.create": {
      description: "Create a new spreadsheet with a title, optionally with named tabs.",
      method: "POST",
      path: "/spreadsheets",
      input: z.object({ title: z.string().min(1), sheetTitles: z.array(z.string().min(1)).optional() }),
      output: spreadsheet,
      effect: "write",
      buildBody: (i) => ({ properties: { title: i.title }, ...(Array.isArray(i.sheetTitles) && { sheets: i.sheetTitles.map((title) => ({ properties: { title } })) }) }),
    },
    "values.get": {
      description: "Read the values of a range as rows of cells. Formulas return their computed value by default.",
      method: "GET",
      path: "/spreadsheets/{spreadsheetId}/values/{range}",
      input: z.object({ spreadsheetId, range, valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional(), majorDimension: z.enum(["ROWS", "COLUMNS"]).optional() }),
      output: valueRange,
      effect: "read",
    },
    "values.update": {
      description: "Overwrite a range with the given rows. Cells outside the values you send are left alone. Replaces existing content.",
      method: "PUT",
      path: "/spreadsheets/{spreadsheetId}/values/{range}",
      input: z.object({ spreadsheetId, range, values: rows, valueInputOption }),
      output: updateResult,
      effect: "write",
      buildQuery: (i) => ({ valueInputOption: i.valueInputOption }),
      buildBody: (i) => ({ values: i.values }),
    },
    "values.append": {
      description: "Add rows after the last row of the table found in the range (the range names the table, e.g. Sheet1!A:C). Nothing existing is overwritten.",
      method: "POST",
      path: "/spreadsheets/{spreadsheetId}/values/{range}:append",
      input: z.object({ spreadsheetId, range, values: rows, valueInputOption, insertDataOption: z.enum(["OVERWRITE", "INSERT_ROWS"]).optional() }),
      output: z.looseObject({ spreadsheetId: z.string().optional(), updates: updateResult.optional() }),
      effect: "write",
      buildQuery: (i) => ({ valueInputOption: i.valueInputOption, ...(i.insertDataOption !== undefined && { insertDataOption: i.insertDataOption }) }),
      buildBody: (i) => ({ values: i.values }),
    },
    "values.clear": {
      description: "Clear the values in a range (formatting stays). The cleared content cannot be recovered through the API.",
      method: "POST",
      path: "/spreadsheets/{spreadsheetId}/values/{range}:clear",
      input: z.object({ spreadsheetId, range }),
      output: z.looseObject({ spreadsheetId: z.string().optional(), clearedRange: z.string().optional() }),
      effect: "destructive",
      buildBody: () => ({}),
    },
    "values.batchGet": {
      description: "Read several ranges of one spreadsheet in a single call.",
      method: "GET",
      path: "/spreadsheets/{spreadsheetId}/values:batchGet",
      input: z.object({ spreadsheetId, ranges: z.array(range).min(1), valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional() }),
      output: z.looseObject({ spreadsheetId: z.string().optional(), valueRanges: z.array(valueRange).optional() }),
      effect: "read",
    },
  },
})

export default googleSheets
