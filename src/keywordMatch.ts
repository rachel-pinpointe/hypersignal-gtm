// Single source of truth for keyword term-matching, shared by:
//   • src/matcher.ts   — include/exclude keyword refinement (with per-tracker exactMatch)
//   • src/db.ts        — the "is exactly (whole word)" advanced-filter operator (jsword SQL function)
//   • src/queryEval.ts — the same, evaluated per-RawJob at tracker-match time
// Keeping the boundary rules in one place is what stops the SQL path, the match path, and the
// per-job path from silently disagreeing about what "react" matches.
//
// Two modes:
//   prefix (default)  — the historical behaviour: 1-3 char terms match a WHOLE word ("ai" hits
//                       "AI Engineer", never "maintenance"); 4+ char terms match a WORD START
//                       ("react" hits "ReactJS", "kubernet" hits "Kubernetes").
//   exact             — WHOLE-WORD on both sides for every length: "react" no longer hits "ReactJS",
//                       "java" no longer hits "JavaScript". This is the "Exact matches only" option.
// A term starting/ending with a non-word char (".net", "c++") gets NO boundary on that side, since
// \b before/after a non-word character means the opposite of what is intended there.

const cache = new Map<string, RegExp>();

export function keywordRegex(kw: string, exact = false): RegExp {
  const key = (exact ? "1:" : "0:") + kw;
  let re = cache.get(key);
  if (!re) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lead = /^\w/.test(kw) ? "\\b" : "";
    // exact: word boundary on the tail for any word-ending term. prefix: boundary only for short
    // (≤3) terms, so longer terms still prefix-match ("react" → "reactjs").
    const tail = /\w$/.test(kw) && (exact || kw.length <= 3) ? "\\b" : "";
    re = new RegExp(`${lead}${esc}${tail}`, "i");
    cache.set(key, re);
  }
  return re;
}

/** Does `text` contain `kw` as a real term rather than as a fragment inside another word? */
export const keywordHit = (text: string, kw: string, exact = false): boolean =>
  !!kw && keywordRegex(kw, exact).test(text);
