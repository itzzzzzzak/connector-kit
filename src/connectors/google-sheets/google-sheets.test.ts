import assert from "node:assert/strict"
import { test } from "node:test"
import { harness, json, standardTests } from "../../connector-harness.test.js"
import sheets from "./index.js"

const SHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
const book = { spreadsheetId: SHEET, spreadsheetUrl: "https://docs.google.com/spreadsheets/d/x/edit", properties: { title: "Budget" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } }] }
const range = { range: "Sheet1!A1:B2", majorDimension: "ROWS", values: [["Name", "Qty"], ["Apples", "3"]] }
const written = { spreadsheetId: SHEET, updatedRange: "Sheet1!A1:B2", updatedRows: 2, updatedColumns: 2, updatedCells: 4 }

standardTests(sheets, { action: "spreadsheets.get", input: { spreadsheetId: SHEET }, ok: book, badInput: { spreadsheetId: "" } })
standardTests(sheets, { action: "spreadsheets.create", input: { title: "Budget", sheetTitles: ["Q1"] }, ok: book, badInput: { title: "" } })
standardTests(sheets, { action: "values.get", input: { spreadsheetId: SHEET, range: "Sheet1!A1:B2" }, ok: range, badInput: { spreadsheetId: SHEET, range: "" } })
standardTests(sheets, { action: "values.update", input: { spreadsheetId: SHEET, range: "Sheet1!A1", values: [["x"]], valueInputOption: "RAW" }, ok: written, badInput: { spreadsheetId: SHEET, range: "Sheet1!A1", values: [["x"]] } })
standardTests(sheets, { action: "values.append", input: { spreadsheetId: SHEET, range: "Sheet1!A:B", values: [["x", 1]], valueInputOption: "USER_ENTERED" }, ok: { spreadsheetId: SHEET, updates: written }, badInput: { spreadsheetId: SHEET, range: "Sheet1!A:B", values: "x", valueInputOption: "RAW" } })
standardTests(sheets, { action: "values.clear", input: { spreadsheetId: SHEET, range: "Sheet1!A1:B2" }, ok: { spreadsheetId: SHEET, clearedRange: "Sheet1!A1:B2" }, badInput: { spreadsheetId: SHEET } })
standardTests(sheets, { action: "values.batchGet", input: { spreadsheetId: SHEET, ranges: ["Sheet1!A1:B2"] }, ok: { spreadsheetId: SHEET, valueRanges: [range] }, badInput: { spreadsheetId: SHEET, ranges: [] } })

test("a range with a sheet name, bang and colon is encoded into one path segment", async () => {
  const { conn, calls } = harness(sheets, () => json(range))
  await conn.execute("values.get", { spreadsheetId: SHEET, range: "Q1 Plan!A1:B2" })
  assert.equal(calls[0]!.url.pathname, `/v4/spreadsheets/${SHEET}/values/Q1%20Plan!A1%3AB2`)
})

test("an update is a PUT with valueInputOption in the query and only the values in the body", async () => {
  const { conn, calls } = harness(sheets, () => json(written))
  await conn.execute("values.update", { spreadsheetId: SHEET, range: "Sheet1!A1:B2", values: [["Name", "Qty"], ["Apples", 3]], valueInputOption: "USER_ENTERED" })
  assert.equal(calls[0]!.init.method, "PUT")
  assert.equal(calls[0]!.url.searchParams.get("valueInputOption"), "USER_ENTERED")
  assert.deepEqual(calls[0]!.body, { values: [["Name", "Qty"], ["Apples", 3]] })
})

test("an append keeps the :append suffix after the encoded range", async () => {
  const { conn, calls } = harness(sheets, () => json({ spreadsheetId: SHEET }))
  await conn.execute("values.append", { spreadsheetId: SHEET, range: "Sheet1!A:B", values: [["x"]], valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" })
  assert.equal(calls[0]!.url.pathname, `/v4/spreadsheets/${SHEET}/values/Sheet1!A%3AB:append`)
  assert.equal(calls[0]!.url.searchParams.get("insertDataOption"), "INSERT_ROWS")
})

test("a spreadsheet read asks only for titles and sizes, never cell data, and clearing is destructive", async () => {
  const { conn, calls } = harness(sheets, () => json(book))
  await conn.execute("spreadsheets.get", { spreadsheetId: SHEET })
  assert.match(calls[0]!.url.searchParams.get("fields")!, /sheets\(properties/)
  assert.doesNotMatch(calls[0]!.url.searchParams.get("fields")!, /data/)
  assert.equal((sheets.actions as Record<string, { effect: string }>)["values.clear"]!.effect, "destructive")
})
