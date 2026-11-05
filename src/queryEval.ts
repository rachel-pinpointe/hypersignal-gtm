// Per-RawJob evaluator for the advanced-filter query tree — the tracker-time twin of db.ts's
// compileQueryTree (which runs the SAME tree as SQL over stored jobs) and web/app.js's evalQueryTree
// (which runs it in the browser over account-check hits). This one lets a tracker carry a saved tree
// as a standing MATCH rule: evaluate() calls it per job so a posting only matches when it satisfies
// the whole tree — "title contains AE AND description mentions Salesforce AND seniority is Senior".
//
// Field/op semantics mirror compileCond in db.ts as closely as a per-object evaluator can:
//   • `monitor` and `starred` are stored-only/attribution fields with no meaning before a job is
//     saved and attributed — they evaluate to a no-op (always pass), never silently reject.
//   • `tech` uses the real detection dictionary (detectedTechNames), shared with the matcher's tech
//     gate via the optional detectTech thunk so detection runs at most once per job.
//   • `anytext` and `matches`/`nmatches` are plain substring / all-words-present, not FTS5 stemming —
//     the same approximation the browser mirror documents.
import type { QueryCond, QueryGroup, RawJob } from "./types.ts";
import { detectedTechNames } from "./techDetect.ts";
import { keywordHit } from "./keywordMatch.ts";

const NUMERIC = new Set(["salaryMin", "salaryMax", "yoe", "companySize"]);
const LISTF = new Set(["tools"]);
const isGroup = (n: QueryCond | QueryGroup): n is QueryGroup => Array.isArray((n as QueryGroup).children);

function asRaw(job: RawJob): Record<string, unknown> {
  const r = job.raw;
  if (r && typeof r === "object") return r as Record<string, unknown>;
  if (typeof r === "string") { try { const p = JSON.parse(r); return p && typeof p === "object" ? p : {}; } catch { return {}; } }
  return {};
}

function fieldValue(job: RawJob, raw: Record<string, unknown>, key: string): unknown {
  switch (key) {
    case "anytext": return `${job.title ?? ""} ${job.company ?? ""} ${job.description ?? ""}`;
    case "title": return job.title;
    case "company": return job.company;
    case "description": return job.description;
    case "location": return job.location;
    case "state": return job.state;
    case "country": return job.country ?? null;
    case "status": return job.status ?? null;
    case "source": return job.source;
    case "remote": return job.remote;
    case "posted": return job.postedAt;
    case "seniority": return raw.seniority ?? null;
    case "industry": return raw.industry ?? null;
    case "salaryMin": return raw.comp_min ?? null;
    case "salaryMax": return raw.comp_max ?? null;
    case "currency": return raw.currency ?? null;
    case "yoe": return raw.yoe ?? null;
    case "companySize": return raw.employees ?? null;
    case "tools": return Array.isArray(raw.tools) ? raw.tools : null;
    default: return null;
  }
}

function evalCond(c: QueryCond, job: RawJob, raw: Record<string, unknown>, cs: boolean, techOf: () => Set<string>): boolean {
  // Stored-only fields have no pre-persist meaning → never reject on them.
  if (c.field === "monitor" || c.field === "starred") return true;

  if (c.field === "tech") {
    const found = techOf();
    if (c.op === "empty") return found.size === 0;
    if (c.op === "nempty") return found.size > 0;
    const vs = (Array.isArray(c.value) ? c.value : c.value == null || c.value === "" ? [] : [c.value]).map((v) => String(v).toLowerCase());
    if (!vs.length) return true;
    const any = vs.some((v) => found.has(v));
    return (c.op === "nhas" || c.op === "noneof") ? !any : any;
  }

  const v = fieldValue(job, raw, c.field);
  const S = (x: unknown) => (x == null ? "" : String(x));
  const norm = (x: unknown) => (cs ? S(x) : S(x).toLowerCase());
  const arr = Array.isArray(c.value) ? c.value.map(String) : c.value == null || c.value === "" ? [] : [String(c.value)];

  switch (c.op) {
    case "contains": return norm(v).includes(norm(c.value));
    case "ncontains": return !norm(v).includes(norm(c.value));
    case "containsany": { const hay = norm(v); return arr.length ? arr.some((x) => hay.includes(norm(x))) : true; }
    case "ncontainsany": { const hay = norm(v); return arr.length ? !arr.some((x) => hay.includes(norm(x))) : true; }
    case "word": return keywordHit(S(v), String(c.value ?? ""), true);
    case "nword": return !keywordHit(S(v), String(c.value ?? ""), true);
    case "eq": return norm(v) === norm(c.value);
    case "neq": return norm(v) !== norm(c.value);
    case "empty": return NUMERIC.has(c.field) ? v == null : LISTF.has(c.field) ? !(Array.isArray(v) && v.length) : S(v).trim() === "";
    case "nempty": return NUMERIC.has(c.field) ? v != null : LISTF.has(c.field) ? Array.isArray(v) && v.length > 0 : S(v).trim() !== "";
    case "is": case "anyof": return !arr.length || arr.includes(S(v));
    case "isnot": case "noneof": return !arr.length || !arr.includes(S(v));
    case "istrue": return !!v;
    case "isfalse": return !v;
    case "gte": return v != null && Number(v) >= Number(c.value);
    case "lte": return v != null && Number(v) <= Number(c.value);
    case "between": { const [lo, hi] = Array.isArray(c.value) ? c.value : [c.value, c.value]; return v != null && Number(v) >= Number(lo) && Number(v) <= Number(hi); }
    case "has": return Array.isArray(v) && v.some((t) => norm(t) === norm(c.value));
    case "nhas": return !(Array.isArray(v) && v.some((t) => norm(t) === norm(c.value)));
    case "matches": case "nmatches": {
      const hay = norm(v);
      const words = String(c.value ?? "").trim().split(/\s+/).filter((w) => !/^(and|or|not)$/i.test(w)).map((w) => norm(w.replace(/\*$/, "")));
      const hit = words.length > 0 && words.every((w) => hay.includes(w));
      return c.op === "matches" ? hit : !hit;
    }
    case "withindays": case "olderdays": {
      const t = Date.parse(S(v)); if (isNaN(t)) return c.op === "withindays"; // unknown date is not a failed "within"
      const days = (Date.now() - t) / 864e5;
      return c.op === "withindays" ? days <= Number(c.value) : days > Number(c.value);
    }
  }
  return true;
}

function evalNode(node: QueryCond | QueryGroup, job: RawJob, raw: Record<string, unknown>, cs: boolean, techOf: () => Set<string>, ctx: { n: number; depth: number }): boolean {
  if (isGroup(node)) {
    if (++ctx.depth > 6) return true;               // over-nested → don't hard-fail a match
    const kids = node.children ?? [];
    if (!kids.length) { ctx.depth--; return true; }
    const combineOr = node.combinator === "OR";
    let result = !combineOr;                          // AND starts true, OR starts false
    for (const child of kids) {
      if (++ctx.n > 200) break;
      const r = evalNode(child, job, raw, cs, techOf, ctx);
      result = combineOr ? result || r : result && r;
    }
    ctx.depth--;
    return result;
  }
  return evalCond(node, job, raw, cs, techOf);
}

/** Does `job` satisfy the advanced-filter tree? Empty/absent tree → true. `detectTech` lets the
 *  caller share an already-computed technology set (the matcher's tech gate) so detection isn't
 *  repeated; omit it and detection runs on demand from the job's title + description. */
export function evalQueryTreeJob(tree: QueryGroup | undefined | null, job: RawJob, detectTech?: () => Set<string>): boolean {
  if (!tree || !Array.isArray(tree.children) || !tree.children.length) return true;
  const raw = asRaw(job);
  let cached: Set<string> | null = null;
  const techOf = detectTech ?? (() => (cached ??= detectedTechNames(`${job.title} ${job.description ?? ""}`)));
  return evalNode(tree, job, raw, !!tree.caseSensitive, techOf, { n: 0, depth: 0 });
}
