// Output formatting must be IDENTICAL on every outbound channel. It was not: both the webhook and the
// CSV exports read the same rows from the same database, but only the webhook normalised timestamps
// and the source label. The same field arrived with a different value depending on how you asked for
// it, and the timestamp half was a bug that had already been FOUND and FIXED — on one channel.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { asIso, publicSource, csvList, csvCell } from "./payload.ts";

test("a SQLite timestamp becomes a real UTC instant", () => {
  // Stored as UTC but with no T and no Z, so `new Date(v)` and Excel both read it as LOCAL time —
  // measured 5.5 hours off in this timezone. Lossless correction, not a reinterpretation.
  assert.equal(asIso("2026-07-25 12:34:35"), "2026-07-25T12:34:35.000Z");
  assert.equal(new Date(asIso("2026-07-25 12:34:35")!).toISOString(), "2026-07-25T12:34:35.000Z");
});

test("values already ISO, empty, or of an unknown shape are left alone", () => {
  assert.equal(asIso("2026-07-25T12:34:35.000Z"), "2026-07-25T12:34:35.000Z");
  assert.equal(asIso("2026-07-25T12:34:35+05:30"), "2026-07-25T12:34:35+05:30", "an offset must survive");
  assert.equal(asIso(null), null);
  assert.equal(asIso(""), null);
  assert.equal(asIso("2026-07-25"), "2026-07-25", "a bare date is not guessed at");
  assert.equal(asIso("last Tuesday"), "last Tuesday", "never invent an instant from an unknown format");
});

test("internal source labels are collapsed, and the ATS board slug is not leaked", () => {
  assert.equal(publicSource("hcorg"), "hiringcafe", "an /org/ scan IS hiring.cafe data");
  assert.equal(publicSource("ats:greenhouse:acme-corp"), "ats", "the vendor's board slug stays internal");
  assert.equal(publicSource("hiringcafe"), "hiringcafe");
  assert.equal(publicSource("craigslist"), "craigslist");
  assert.equal(publicSource(null), "");
});

test("a JSON-list column renders as a readable cell, not as raw JSON", () => {
  // commitment is stored as ["Full Time"], and json_extract returns that literal text. Written
  // straight into a cell the user opens a spreadsheet and reads `["Full Time"]` — valid CSV,
  // unusable data. Joined with "; " to match the convention `technologies` already uses, so a
  // multi-value cell looks the same whichever column it is in.
  assert.equal(csvList('["Full Time"]'), "Full Time");
  assert.equal(csvList('["Full Time", "Part Time"]'), "Full Time; Part Time");
  assert.equal(csvList('[]'), "");
  // Anything that is not a JSON array passes through untouched, so this is safe on any field that
  // MIGHT be one.
  assert.equal(csvList("Senior Level"), "Senior Level");
  assert.equal(csvList(null), null);
  assert.equal(csvList(120000), "120000");
  // Malformed JSON shows what is STORED rather than nothing — losing the value to a parse error
  // would be worse than showing it awkwardly.
  assert.equal(csvList('["unterminated'), '["unterminated');
});

// Every value in a CSV export is third-party SCRAPED text. Excel and Google Sheets execute a cell
// that begins with = + - @, so an export the user opens on their own machine could run whatever a
// job board's HTML said. A leading apostrophe neutralises it and is not displayed.
test("a scraped cell cannot become a spreadsheet formula", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+44 Recruiting"), "'+44 Recruiting");
  assert.equal(csvCell("@channel"), "'@channel");
  assert.equal(csvCell("-Senior Engineer"), "'-Senior Engineer");
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`,
    "the guard runs BEFORE quoting, so an injected cell is still valid CSV");
  // …and an ordinary cell is untouched.
  assert.equal(csvCell("Senior Engineer"), "Senior Engineer");
  assert.equal(csvCell("Acme, Inc."), '"Acme, Inc."');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(120000), "120000");
});
