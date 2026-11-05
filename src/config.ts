import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { ClientConfig } from "./types.ts";
import { dbGetAllClientConfigs, dbGetClientConfig, dbClientExists, dbUpsertClientConfig, dbDeleteClient, dbRenameClient } from "./db.ts";

// Single source backbone: hiring.cafe always, Craigslist + SimplyHired added in "corporate_local".
export const SOURCE_TYPES = ["hiringcafe", "craigslist", "simplyhired"] as const;

/**
 * MOST DOMAINS A SINGLE MONITOR MAY WATCH.
 *
 * Cost per domain is not the fetch — it is the ATS discovery that runs BEFORE any job is fetched:
 * every watched company is probed for a Greenhouse/Lever/Ashby board, measured at ~4 a second on a
 * cold cache. A 7,470-company watchlist therefore spent about half an hour finding nothing before it
 * started, which is what prompted this limit.
 *
 * Enforced HERE, in the schema, rather than only in the browser, so it holds for a hand-edited YAML
 * file and the API too — the same fail-closed rule the rest of this codebase follows. It REJECTS
 * rather than trimming: silently keeping the first 10,000 and dropping the rest is exactly the silent
 * cap this project keeps having to hunt down, and the owner of the list is the only one who can say
 * which companies matter.
 *
 * Matches ACCOUNT_MAX, the Account Check upload ceiling, so the two surfaces agree on one number.
 */
export const DOMAIN_CAP = Math.max(1, Number(process.env.ACCOUNT_MAX ?? 10000));

const num = z.number().nullish();
const strArr = z.array(z.string()).optional();
const clientSchema = z.object({
  name: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9 _-]*$/i, "name must start with a letter or number; letters, numbers, spaces, dash, underscore allowed"),
  active: z.boolean().default(true),
  kind: z.enum(["search", "watchlist"]).default("search"), // watchlist = Account Monitoring (domain-scoped)
  search: z.object({
    keywords: z.array(z.string()).default([]),
    keywordScope: z.enum(["anywhere", "title", "description"]).optional(),     // which field include keywords must hit
    exclude: strArr,
    excludeKeywordScope: z.enum(["anywhere", "title", "description"]).optional(), // which field exclude keywords test
    exactMatch: z.boolean().optional(),              // whole-word keyword matching (include + exclude)
    excludeCompanies: strArr,
    technologies: strArr,                            // local detected-technology gate (match only postings mentioning ANY of these)
    matchFilter: z.any().optional(),                 // advanced matching rule tree (evaluated per-job by src/queryEval.ts)
    sourceMode: z.enum(["corporate", "corporate_local"]).optional(),
    orgDomains: strArr,                              // hiring.cafe /org/<domain> deterministic monitoring
    includeOrgJobs: z.boolean().optional(),          // search-only: also match org rows fetched by other monitors/account-checks
    useAts: z.boolean().optional(),                  // default true: also pull each domain's Greenhouse/Lever/Ashby board
    extraBoards: z.array(z.enum(["remoteok", "wwr"])).optional(), // search-only opt-in free remote boards
    locations: z.array(z.any()).optional(),         // hiring.cafe placeDetail objects
    workplaceTypes: strArr,
    commitmentTypes: strArr,
    seniorityLevels: strArr,
    departments: strArr,
    roleTypes: strArr,
    industries: strArr,
    companySizeRanges: z.array(z.array(z.union([z.number(), z.null()]))).optional(),
    fundingStages: strArr,
    securityClearances: strArr,
    organizationTypes: strArr,
    minYearFounded: num, maxYearFounded: num,
    yoeMin: num, yoeMax: num, excludeIfNoYoe: z.boolean().optional(),
    salaryMin: num, salaryMax: num, salaryCurrency: z.string().optional(),
    salaryFrequency: z.string().optional(), onlyTransparentSalary: z.boolean().optional(),
    datePostedDays: z.number().optional(),
    sortBy: z.string().optional(),
    searchDepth: z.enum(["quick", "standard", "deep"]).optional(),
  }).nullish().transform((v) => v ?? { keywords: [] }),
  refreshCron: z.string().optional(),
  schedule: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("interval"), every: z.number().int().positive(), unit: z.enum(["minute", "hour", "day"]) }),
    z.object({ mode: z.literal("recurring"), times: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1),
      days: z.enum(["everyday", "weekdays", "weekends"]).optional(),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      daysOfMonth: z.array(z.number().int().min(1).max(31)).optional() }),
    z.object({ mode: z.literal("once"), at: z.string().min(1) }),
    z.object({ mode: z.literal("cron"), expr: z.string().min(1) }),
  ]).nullish(),
  signals: z.array(z.string()).optional(),  // enabled signal-producer keys (watchlist monitoring)
  company_signals: z.object({ min_open_roles: z.number().optional(), flag_repeat_postings: z.boolean().optional() }).nullish(),
  delivery: z.object({
    webhook_url: z.union([z.string().url(), z.literal("")]).optional(),
    mode: z.enum(["realtime", "scheduled"]).optional(),
    schedule: z.string().optional(),
  }).nullish(),
  // Per-signal-type webhook routing: signal FAMILY ("funding"/"warn"/"velocity"/…) → URL. A signal
  // whose family is here POSTs to that URL instead of delivery.webhook_url; unlisted families fall back.
  signal_webhooks: z.record(z.string(), z.union([z.string().url(), z.literal("")])).optional(),
}).refine(
  (c) => c.kind !== "watchlist" || ((c.search?.orgDomains ?? []).filter(Boolean).length > 0),
  { message: "A watchlist needs at least one domain to monitor", path: ["search", "orgDomains"] },
).refine(
  (c) => (c.search?.orgDomains ?? []).filter(Boolean).length <= DOMAIN_CAP,
  (c) => ({
    message: `${(c.search?.orgDomains ?? []).filter(Boolean).length.toLocaleString("en-US")} domains is over the `
      + `${DOMAIN_CAP.toLocaleString("en-US")} limit — split this into more than one monitor`,
    path: ["search", "orgDomains"],
  }),
);

// A function, not a frozen module-level const: reads the env var at each call so tests can point
// this at a throwaway temp directory per-case (a `const` evaluated once at import time, before any
// test gets to set the env var, made seedFromYaml's own refresh behavior untestable in isolation --
// found while adding the coverage for the domain-refresh fix below).
function clientsDir(): string { return process.env.CLIENTS_DIR ?? "clients"; }

const REMOTE_TO_WP: Record<string, string[]> = { remote: ["Remote"], hybrid: ["Hybrid"], onsite: ["Onsite"] };
const SENIORITY_TO_LEVELS: Record<string, string[]> = { entry: ["Entry Level"], mid: ["Mid Level"], senior: ["Senior Level"] };
const CATEGORY_TO_DEPTS: Record<string, string[]> = {
  customer_service: ["Customer Service"], admin: ["Administrative & Clerical Support"],
  data_entry: ["Administrative & Clerical Support"], accounting: ["Finance and Accounting"],
  sales: ["Sales"], marketing: ["Marketing"], healthcare: ["Healthcare Services - Allied Health"],
  software_it: ["Software Development", "Information Technology"], general_labor: ["Skilled Trades - General Labor"],
};

/** Convert any legacy config shape (multi-source + remote/jobTypes/category/seniority) to the
 *  hiring.cafe-modeled shape. Idempotent: a config already in the new shape passes through. */
function migrateIfLegacy(raw: any): any {
  if (!raw) return raw;
  const s = raw.search ?? {};
  const legacy = Array.isArray(raw.sources) || "remote" in s || "category" in s || "jobTypes" in s || "seniority" in s || typeof s.location === "string";
  if (!legacy) return raw;

  // very-legacy: sources were SourceConfig objects + a top-level `filters` block
  const f = raw.filters ?? {};
  const keywords = s.keywords ?? f.include_keywords ?? [];
  const hadLocalSrc = Array.isArray(raw.sources) && raw.sources.some((x: any) => (typeof x === "string" ? x : x?.type) === "craigslist" || (typeof x === "string" ? x : x?.type) === "simplyhired");

  // Same rule as the outer object: keep everything, override only what is actually being translated.
  // Listing the fields explicitly dropped ORG DOMAINS — the entire point of a watchlist — along with
  // technologies, useAts, extraBoards, industries, funding stages, company sizes, YOE and salary
  // bounds. A config carrying one legacy key (`search.remote` is enough) lost all of them on load.
  const { remote: _r, category: _c, jobTypes: _j, seniority: _sn, location: _l, ...restSearch } = s;
  const search: any = {
    ...restSearch,
    keywords,
    exclude: s.exclude ?? f.exclude_keywords ?? [],
    excludeCompanies: s.excludeCompanies ?? [],
    sourceMode: s.sourceMode ?? (hadLocalSrc ? "corporate_local" : "corporate"),
    // A legacy free-text location cannot be geocoded here, so it is dropped and the user re-picks in
    // the UI — but a config that already has real placeDetail objects keeps them.
    locations: Array.isArray(s.locations) ? s.locations : [],
    workplaceTypes: s.remote && REMOTE_TO_WP[s.remote] ? REMOTE_TO_WP[s.remote] : (s.workplaceTypes ?? []),
    commitmentTypes: s.jobTypes ?? s.commitmentTypes ?? [],
    seniorityLevels: s.seniority && SENIORITY_TO_LEVELS[s.seniority] ? SENIORITY_TO_LEVELS[s.seniority] : (s.seniorityLevels ?? []),
    departments: s.category && CATEGORY_TO_DEPTS[s.category] ? CATEGORY_TO_DEPTS[s.category] : (s.departments ?? []),
    datePostedDays: s.datePostedDays ?? 0,
    searchDepth: s.searchDepth ?? "deep",
    sortBy: s.sortBy ?? "default",
  };
  // Spread `raw` FIRST and override only what the migration actually rewrites. This used to build a
  // fresh object listing six fields, which silently DROPPED every field added since it was written:
  // kind, signals, signal_webhooks and schedule.
  //
  // Losing `kind` is the dangerous one. A watchlist that came through here would come out as a
  // SEARCH, and the two are not variations of one thing — materializeSources gives a watchlist one
  // domain-scoped /org/ source per company and gives a search a market-wide hiring.cafe query per
  // keyword. So the watchlist would stop monitoring its accounts and start crawling the whole job
  // market under the same name, with its signal producers switched off (signals dropped) and its
  // schedule gone. Nothing would report an error; it would just quietly be a different product.
  //
  // Not currently reachable — neither stored config trips the `legacy` test above — but this runs on
  // EVERY load, the test includes `"remote" in s` which is true for a merely PRESENT key, and the
  // migration output is used by loadClients() without re-validation. A latent silent-conversion bug
  // in a path that runs constantly is worth closing even at zero current incidence.
  const { sources: _s, filters: _f, ...rest } = raw;   // the legacy carriers, now folded into `search`
  return {
    ...rest,
    name: raw.name, active: raw.active ?? true, search,
    refreshCron: raw.refreshCron ?? "0 * * * *",
    company_signals: raw.company_signals, delivery: raw.delivery,
  };
}

/** Validate a raw config object (migrating legacy shapes). Throws on failure. */
export function validateClient(raw: unknown): ClientConfig {
  const parsed = clientSchema.safeParse(migrateIfLegacy(raw));
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "));
  }
  return parsed.data as ClientConfig;
}

/** ${ENV_VAR} interpolation in string values (webhook secrets, unblocker URLs). */
function interpolateEnv<T>(obj: T): T {
  if (typeof obj === "string") return obj.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "") as unknown as T;
  if (Array.isArray(obj)) return obj.map(interpolateEnv) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = interpolateEnv(v);
    return out as T;
  }
  return obj;
}

/** Import clients/*.yaml into the DB: a full seed for any client not already stored, and — for one
 *  already stored — a narrow refresh of ONLY its domain list from the file. */
export function seedFromYaml(): void {
  if (!existsSync(clientsDir())) return;
  const files = readdirSync(clientsDir()).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith("_"));
  for (const f of files) {
    try {
      const raw = yaml.load(readFileSync(join(clientsDir(), f), "utf8")) as { name?: string; search?: { orgDomains?: unknown[] } };
      if (!raw?.name) continue;
      if (!dbClientExists(raw.name)) {
        const valid = validateClient(raw);
        dbUpsertClientConfig(valid.name, JSON.stringify(valid));
        console.log(`[config] seeded client "${valid.name}" from ${f}`);
        continue;
      }
      // Already stored -- but sync_watchlist.py (Fibery -> this YAML) rewrites ONLY search.orgDomains
      // in this file every cron run, on the documented assumption that doing so keeps the LIVE
      // watchlist current with Fibery (its own docstring literally says "actually wired up here").
      // Found live 2026-09-18: that assumption was false. This function used to skip an
      // already-seeded client entirely, so the file's daily orgDomains updates never reached the
      // DB-stored config loadClients() actually reads at scan time -- the running watchlist had been
      // frozen at its original 20-domain seed (Phase 4's "frozen 83-company CFO-pipeline batch"
      // sample) since inception, silently never growing to track the ~1,535 companies Fibery has held
      // since the full Paradigm import (Section 5a) -- almost the entire real company universe has
      // never actually been signal-scanned. Every OTHER field in the stored config (producer
      // selection, refreshCron, anything a person can edit in HyperSignal's own dashboard) is left
      // exactly as stored, mirroring sync_watchlist.py's own narrow scope, so this refresh can never
      // silently revert a live UI edit to something it wasn't meant to touch.
      const existingRaw = dbGetClientConfig(raw.name);
      if (!existingRaw) continue;
      const existing = migrateIfLegacy(JSON.parse(existingRaw)) as ClientConfig;
      const freshDomains = ((raw.search?.orgDomains ?? []) as unknown[]).map(String);
      if (!freshDomains.length) continue; // never blank out a live watchlist from an empty/unreadable file
      const existingDomains = existing.search?.orgDomains ?? [];
      if (existingDomains.length === freshDomains.length && existingDomains.every((d, i) => d === freshDomains[i])) continue; // unchanged
      const merged: ClientConfig = { ...existing, search: { ...existing.search, orgDomains: freshDomains } };
      const valid = validateClient(merged);
      dbUpsertClientConfig(valid.name, JSON.stringify(valid));
      console.log(`[config] refreshed "${valid.name}" watchlist domains from ${f}: ${existingDomains.length} -> ${freshDomains.length}`);
    } catch (e) {
      console.error(`[config] ${f} seed failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Load all clients from the DB, migrating legacy shapes + env-interpolated.
 *
 * ONE BAD ROW MUST NOT TAKE DOWN THE OTHERS. This mapped straight over the rows, so an unparseable
 * config — a truncated write, a hand-edited row, a future migration that emits a shape
 * migrateIfLegacy chokes on — threw out of the whole function. Every caller is boot or reload, so
 * the effect was total: the app could not start, and no client fetched, matched or delivered
 * anything, because of one row belonging to one of them.
 *
 * A skipped client is loudly logged rather than silently dropped: it will look like it simply
 * stopped working, and the log line is the only thing that says why.
 */
export function loadClients(): ClientConfig[] {
  const out: ClientConfig[] = [];
  for (const r of dbGetAllClientConfigs()) {
    try { out.push(interpolateEnv(migrateIfLegacy(JSON.parse(r.config)) as ClientConfig)); }
    catch (e) {
      console.error(`[config] SKIPPING client "${r.name}" — its stored config could not be read: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Read one client's config for editing in the UI (migrated to the standardized shape). */
export function getClientRaw(name: string): ClientConfig | null {
  const json = dbGetClientConfig(name);
  return json ? (migrateIfLegacy(JSON.parse(json)) as ClientConfig) : null;
}

/** The only shape a client name may take on disk — mirrors the zod rule on ClientSchema.name.
 *  EVERY filesystem path in this file is built through here, because the rename and delete routes
 *  take the name straight out of the URL and Express URL-decodes route params, so a request for
 *  "..%2F..%2Fnotes" arrives as the string "../../notes". The regex alone is sufficient (it admits
 *  no "/" or "."), and the dirname check is a second lock in case the regex is ever loosened. */
const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9 _-]*$/i;
function clientFile(name: string): string {
  const n = name.trim();
  if (!CLIENT_NAME_RE.test(n)) throw new Error(`Invalid client name: ${name}`);
  const f = resolve(clientsDir(), `${n}.yaml`);
  if (dirname(f) !== resolve(clientsDir())) throw new Error(`Invalid client name: ${name}`);
  return f;
}

/** Validate + persist a client to the DB and write a YAML backup. Returns the stored config. */
export function saveClient(raw: unknown): ClientConfig {
  const valid = validateClient(raw);
  dbUpsertClientConfig(valid.name, JSON.stringify(valid));
  try { writeFileSync(clientFile(valid.name), yaml.dump(valid, { lineWidth: 100 })); } catch { /* backup best-effort */ }
  return valid;
}

/** Rename a client, validating the new config and keeping its match history. */
export function renameClient(oldName: string, raw: unknown): ClientConfig {
  const oldFile = clientFile(oldName);   // reject a traversing oldName before touching the DB
  const valid = validateClient(raw);
  if (valid.name !== oldName && dbClientExists(valid.name)) throw new Error(`A client named "${valid.name}" already exists`);
  dbRenameClient(oldName, valid.name, JSON.stringify(valid));
  try {
    writeFileSync(clientFile(valid.name), yaml.dump(valid, { lineWidth: 100 }));
    if (oldName !== valid.name && existsSync(oldFile)) rmSync(oldFile);
  } catch { /* best-effort */ }
  return valid;
}

/** Delete a client (DB rows + YAML file). */
export function deleteClient(name: string): void {
  const f = clientFile(name);            // reject a traversing name before deleting anything
  dbDeleteClient(name);
  try { if (existsSync(f)) rmSync(f); } catch { /* best-effort */ }
}
