// Output formatting shared by EVERY outbound channel — webhooks and CSV exports alike.
//
// This module exists because the two channels had silently diverged. Both read the same rows from the
// same database, but the webhook path applied two corrections that the CSV path did not, so the same
// field arrived with a different value depending on how you asked for it:
//
//   • TIMESTAMPS. SQLite's datetime('now') yields "2026-07-25 12:34:35" — UTC, but with no `T` and no
//     `Z`. A consumer doing `new Date(value)` reads that as LOCAL time: measured 5.5 hours off in this
//     timezone, and Excel does the same thing to a CSV cell. This was found once and fixed in
//     delivery.ts only, so the webhook has been correct and every CSV export has been wrong since.
//
//   • SOURCE. Internally a row's source is "hcorg" or "ats:greenhouse:acme-corp" — an implementation
//     detail that also leaks the board slug. The webhook collapsed it to "hiringcafe" / "ats"; the CSV
//     shipped the raw string.
//
// A shared helper is the point, not a tidier one. Two copies of a formatting rule drift the moment one
// is fixed, and this pair is the proof: the bug was FOUND, FIXED, and still shipped on the other
// channel. Anything that shapes a value for the outside world belongs here, used by both.

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no T/Z) → a real ISO instant. Pass-through for anything already
 *  ISO, and for values that are neither (never guess at an unknown format). */
export function asIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (s.includes("T")) return s;                                   // already an instant
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + ".000Z" : s;
}

/** Escape one value as a CSV cell (RFC 4180: quote when it contains a comma, quote or newline).
 *
 *  Shared for the same reason as the two above: this was copy-pasted into all SIX export endpoints,
 *  and a bug in one copy does not get fixed in the others. There is already a comment in the signals
 *  export recording exactly that — `JSON.stringify(detail ?? "")` turned a null into the two-character
 *  string `""`, which the escaper then doubled into `""""`, putting quote marks in every empty cell.
 *  Null and undefined are an EMPTY cell, never the text "null". */
export function csvCell(v: unknown): string {
  let t = v == null ? "" : String(v);
  // Formula-injection guard. Every value that reaches here is third-party SCRAPED text — a job title,
  // a company name, a description — and Excel and Google Sheets execute a cell that begins with
  // = + - @ (or a leading tab / CR before one). The user opens their own export and the spreadsheet
  // runs whatever a job board's HTML said. A leading apostrophe is the standard neutraliser: the
  // spreadsheet treats the cell as text and does not display the quote.
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/**
 * A value that is a JSON LIST in the database, rendered for a CSV cell.
 *
 * Several enrichment fields are stored as arrays — `commitment` is `["Full Time"]`, and json_extract
 * hands that back as the literal text `["Full Time"]`. Written straight into a cell the user opens a
 * spreadsheet and reads `["Full Time"]`, brackets and quotes included. Valid CSV, unusable data.
 *
 * Joined with "; ", matching the convention `technologies` already uses in the same file, so a
 * multi-value cell looks the same whichever column it is in. A value that is not a JSON array is
 * returned untouched, so this is safe to apply to any field that MIGHT be one.
 */
export function csvList(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s.startsWith("[")) return s;
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => String(x ?? "").trim()).filter(Boolean).join("; ") : s;
  } catch { return s; }   // not JSON after all — show what is stored rather than nothing
}

/** Internal source → the public label. "hcorg" is hiring.cafe data fetched via an /org/<domain> scan,
 *  so it is presented as hiringcafe; "ats:greenhouse:acme-corp" becomes "ats" rather than leaking the
 *  vendor's board slug to a downstream system. */
export function publicSource(v: unknown): string {
  const s = String(v ?? "").split(":")[0] ?? "";
  return s === "hcorg" ? "hiringcafe" : s;
}
