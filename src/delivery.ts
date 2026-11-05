import { randomUUID } from "node:crypto";
import { getUndelivered, countUndelivered, markMatchesDelivered, markAllUndeliveredDelivered, getUndeliveredSignals, getUndeliveredCheckSignals, markSignalDelivered, markSignalsDelivered, countUndeliveredSignals, SIGNAL_BACKLOG_CAP, dbGetSettings, dbRecordDelivery } from "./db.ts";
import { legacyFamily, categoryOf } from "./signals/taxonomy.ts";
import type { ClientConfig } from "./types.ts";
import { ownerFetch } from "./safeFetch.ts";
import { asIso, publicSource } from "./payload.ts";

/** True when a client should be delivered the moment new matches land (default). */
export function isRealtime(client: ClientConfig): boolean {
  return (client.delivery?.mode ?? "realtime") === "realtime";
}

/** Shape one DB row into a webhook signal. Carries the rich hiring.cafe facets we capture (salary,
 *  seniority, company firmographics, status, domain) so downstream gets a real hiring signal, not
 *  just a title+url. Enrichment fields are null for non-hiring.cafe (Craigslist/SimplyHired) jobs.
 *  `first_seen_at` is always present (reliable) since `posted_at` can be null for some sources. */
// asIso / publicSource now live in ./payload.ts and are shared with the CSV exports. They were
// private to this file, which is exactly how the two channels drifted: the ISO fix was made here and
// the exports kept shipping SQLite's "YYYY-MM-DD HH:MM:SS" for the same fields.

export function toSignal(r: Record<string, unknown>) {
  let raw: Record<string, unknown> = {};
  try { const p = r.raw ? JSON.parse(String(r.raw)) : null; if (p && typeof p === "object") raw = p as Record<string, unknown>; } catch { /* non-JSON / "null" → keep {} */ }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  // `period` follows the same rule this file already applies to `currency`, one line down: state what
  // the data supports and NOTHING else. It was hardcoded "yearly" because the upstream field is named
  // yearly_min_compensation — but the values in that field are demonstrably not all annual:
  //   "Class A Driver"            27–27 USD    → an hourly wage
  //   "Electronics Technician"    20–24 USD    → an hourly wage
  //   "Field Sales Consultant"    24–30 INR    → Indian listings quote LAKHS per annum (₹2.4M–3M)
  // 35 rows in the live data are below 1,000. Asserting "yearly" over those tells a CRM that a truck
  // driver earns $27 a year, in a field that looks authoritative and that nobody re-checks.
  //
  // The app cannot know WHICH of hourly / lakhs / upstream error applies, and guessing would just be
  // a nicer-looking invention. So below the plausibility floor it reports the figure and says the
  // period is unknown. A consumer can then skip or flag it; today it silently stores nonsense.
  const compMin = num(raw.comp_min), compMax = num(raw.comp_max);
  const headline = compMax ?? compMin;
  // 1,000 is safe in every currency present in the data (USD/EUR/GBP/CAD/INR/JPY/HUF/…): no real
  // annual salary is below it, and no hourly rate or lakh figure is above it.
  const plausiblyAnnual = headline != null && headline >= 1000;
  const compensation = (raw.comp_min != null || raw.comp_max != null)
    // currency is null when the source didn't state one — NEVER defaulted to USD. A webhook consumer
    // that receives an invented currency writes a wrong number into a CRM and nobody catches it.
    ? { min: compMin, max: compMax, currency: (typeof raw.currency === "string" && raw.currency.trim()) ? raw.currency.trim() : null, period: plausiblyAnnual ? "yearly" : null }
    : null;
  return {
    id: r.id, title: r.title,
    company: r.company,
    company_domain: (r.domain as string) || null,   // employer's own domain when resolvable
    location: r.location, state: r.state, remote: !!r.remote,
    status: (r.status as string) ?? "open",         // open | closed
    url: r.url,                                      // real apply URL
    // hcorg (deterministic /org/<domain> scan) is hiring.cafe data — present it as such; the
    // match_reason ("corporate · org") is what flags an org-sourced signal.
    source: publicSource(r.source),
    posted_at: asIso(r.posted_at),                  // when the employer posted it (may be null)
    first_seen_at: asIso(r.seen_at),                // when we first ingested the JOB (always set)
    // ADDITIVE under schema_version 2. When it became a match FOR THIS CLIENT — a job already in the
    // database matches the instant a new watchlist starts watching its domain, so this can be much
    // later than first_seen_at. The CSV export has always carried it; the webhook had not.
    matched_at: asIso(r.matched_at),
    match_reason: r.matchReason,
    // ADDITIVE under schema_version 2, and the field with the strongest claim to be here: the
    // matcher can GATE a match on technologies ("only alert me when these companies hire for
    // React"), so without this a client could ask to hear only about React roles, be told about one,
    // and never be told that React was the reason. An array, not the CSV's "; "-joined string — a
    // JSON consumer should not have to re-split a list we already had as one. Empty array rather
    // than null when nothing was detected: "we looked and found none" is an answer, and the same
    // measured-vs-unknown distinction the signal producers make.
    technologies: typeof r.technologies === "string" && r.technologies.trim()
      ? r.technologies.split(";").map((t) => t.trim()).filter(Boolean) : [],
    // Full scraped JD — present for org/watchlist + account-check matches (the /org/ path captures the
    // detail URL). Keyword searches can't be JD-scraped (virtualized list), so they fall back to the
    // free structured summaries below, which ship for every hiring.cafe job at no extra fetch.
    description: (raw.description as string) ?? null,
    requirements_summary: raw.requirements_summary ?? null,
    role_activities: raw.role_activities ?? null,
    // hiring.cafe enrichment (null for local sources)
    seniority: raw.seniority ?? null,
    years_experience_min: num(raw.yoe),
    job_category: raw.job_category ?? null,
    commitment: raw.commitment ?? null,
    workplace_type: raw.workplace_type ?? null,
    visa_sponsorship: raw.visa_sponsorship ?? null,
    security_clearance: raw.security_clearance ?? null,
    compensation,
    company_info: {
      industry: raw.industry ?? null,
      employees: raw.employees ?? null,
      founded: raw.founded ?? null,
      org_type: raw.org_type ?? null,
      funding_type: raw.funding_type ?? null,
      funding_year: raw.funding_year ?? null,
    },
  };
}

/**
 * POST undelivered matches for a client to its webhook, in batches so a backlog never fires
 * one giant payload. Each batch carries headers identifying the event/client/batch, and is
 * only marked delivered on a 2xx. On any failure we stop and leave the rest for next cycle.
 */
export async function deliver(client: ClientConfig): Promise<number> {
  const webhook = client.delivery?.webhook_url?.trim();
  // Count first, fetch per batch. Reading the entire undelivered backlog up front allocated tens to
  // hundreds of MB for a client whose webhook had been failing, and blocked the event loop for the
  // whole read — while the batch size bounded only the payload, never the memory.
  const totalRows = countUndelivered(client.name);
  if (!totalRows) return 0;

  if (!webhook) {
    // No webhook configured: the dashboard is the sole sink, so retire the backlog in ONE
    // statement. This used to read every undelivered row — each with its full raw JSON blob — into
    // an array just to collect match ids, which is the unbounded materialization the batching work
    // in this file exists to avoid.
    markAllUndeliveredDelivered(client.name);
    return 0;
  }

  const { webhookBatchSize } = dbGetSettings();
  const size = webhookBatchSize > 0 ? webhookBatchSize : totalRows;
  const batchTotal = Math.max(1, Math.ceil(totalRows / size));
  const deliveryId = randomUUID();
  let sent = 0;

  for (let b = 0; b < batchTotal; b++) {
    // Delivered rows drop out of the query, so the next page is always the next undelivered batch.
    const batch = getUndelivered(client.name, size);
    if (!batch.length) break;
    const signals = batch.map(toSignal);
    try {
      const res = await ownerFetch(webhook, {
        method: "POST",
        signal: AbortSignal.timeout(20000), // bound each POST so a hung/slow receiver can't stall the delivery loop
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "HyperSignal-Hiring/1.0",
          "X-HyperSignal-Event": "matches.new",
          "X-HyperSignal-Schema": "2",
          "X-HyperSignal-Client": client.name,
          "X-HyperSignal-Delivery": deliveryId,
          "X-HyperSignal-Batch": `${b + 1}/${batchTotal}`,
          "X-HyperSignal-Count": String(signals.length),
        },
        body: JSON.stringify({
          event: "matches.new",
          schema_version: 2,
          client: client.name,
          delivery_id: deliveryId,
          batch: { index: b + 1, total: batchTotal, size },
          count: signals.length,        // signals in THIS batch
          total_count: totalRows,       // signals across the whole delivery
          signals,
        }),
      });
      if (!res.ok) { const m = `HTTP ${res.status} on batch ${b + 1}/${batchTotal} — ${totalRows - sent} left for retry`; console.warn(`[deliver:${client.name}] webhook ${m}`); dbRecordDelivery(client.name, false, m); break; }
      markMatchesDelivered(batch.map((r) => Number(r.match_id)));
      sent += signals.length;
      if (b < batchTotal - 1) await new Promise((r) => setTimeout(r, 400)); // pace batches so we don't flood the receiver
    } catch (e) {
      const m = `${(e as Error).message} — will retry next cycle`; console.warn(`[deliver:${client.name}] webhook error on batch ${b + 1}: ${m}`); dbRecordDelivery(client.name, false, m);
      break;
    }
  }
  // A run that got everything through clears any recorded failure, so a recovered endpoint stops
  // warning by itself rather than needing a manual reset.
  if (sent >= totalRows) dbRecordDelivery(client.name, true, `delivered ${sent}`);
  return sent;
}

/**
 * POST undelivered non-hiring SIGNALS (funding, tech changes, velocity, …) to the client's webhook —
 * the exact same machinery as job matches: batched by webhookBatchSize, 2xx-gated marking, stop on
 * the first failure. Payload event is "signals.new" and each item carries `signal_type` so a
 * Zapier/Slack route can branch per type.
 *
 * AT-LEAST-ONCE, not exactly-once. A batch is marked delivered only AFTER its POST returns 2xx, so
 * anything that ends the process between the receiver accepting the batch and the mark landing
 * (a crash, the auto-quit timer) re-sends that batch next cycle. This is the deliberate trade: the
 * other order would silently DROP a batch whose POST never arrived, and a duplicate is recoverable
 * where a loss is not. Every payload carries `delivery_id` + `batch` so a receiver can dedupe.
 * (The comments here used to claim "nothing is ever double-sent", which is the opposite of what
 * the code does.)
 */
// Legacy hyphen-prefix "family" ("funding-form-d" → "funding") — imported from the taxonomy so there
// is ONE definition. Kept solely so route keys saved before categories existed keep working.

/** POST a set of signal rows to ONE webhook — batched, 2xx-gated, stop-on-first-failure, each
 *  delivered batch marked in one transaction. At-least-once; see the note above. `source` labels
 *  the payload/headers. Shared by watchlist routing and one-off checks. */
async function postSignalRows(webhook: string, rows: Array<Record<string, unknown>>, source: string): Promise<number> {
  if (!rows.length) return 0;
  const { webhookBatchSize } = dbGetSettings();
  const size = webhookBatchSize > 0 ? webhookBatchSize : rows.length;
  const batches: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size));
  const deliveryId = randomUUID();
  let sent = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const items = batch.map((r) => {
      let detail: unknown = null;
      try { detail = r.detail ? JSON.parse(String(r.detail)) : null; } catch { /* keep null */ }
      return {
        // ADDITIVE ONLY under schema_version 1: signal_type keeps its exact historical value so a
        // consumer branching on it never breaks. signal_category is the cross-source meaning
        // ("funding" for a US Form D, a UK SH01 or a press report) and evidence_rank says how hard
        // the evidence is (official filing 100 > our own observation 70 > press 20). Renaming or
        // removing a field here requires schema_version: 2.
        // signal_id is THE field that makes at-least-once delivery safe, and it was the one field
        // missing. This delivery re-sends a batch whenever the process dies between the receiver
        // accepting it and the mark landing (documented above as the deliberate trade), and the
        // payload's own answer to that was `delivery_id` + `batch` — which identifies the ENVELOPE,
        // not the signal. A receiver could only dedupe by remembering every delivery id it had ever
        // seen; two different batches carrying the same signal were indistinguishable. The row's
        // primary key was already being SELECTed (SIGNAL_COLS) and then dropped here. It is stable
        // for the life of the row, so a consumer can upsert on it and stop caring how often we send.
        signal_id: r.id,
        signal_type: r.type, signal_category: r.category ?? "other", evidence_rank: r.evidence_rank ?? 0,
        title: r.title, company: r.company ?? null, company_domain: r.domain || null,
        url: r.url ?? null, detail, observed_at: asIso(r.observed_at), first_seen_at: asIso(r.created_at),
      };
    });
    try {
      const res = await ownerFetch(webhook, {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: {
          "Content-Type": "application/json", "User-Agent": "HyperSignal-Hiring/1.0",
          "X-HyperSignal-Event": "signals.new", "X-HyperSignal-Schema": "1", "X-HyperSignal-Client": source,
          "X-HyperSignal-Delivery": deliveryId, "X-HyperSignal-Batch": `${b + 1}/${batches.length}`, "X-HyperSignal-Count": String(items.length),
        },
        body: JSON.stringify({
          event: "signals.new", schema_version: 1, client: source, delivery_id: deliveryId,
          batch: { index: b + 1, total: batches.length, size }, count: items.length, total_count: rows.length, signals: items,
        }),
      });
      if (!res.ok) { const m = `HTTP ${res.status} on batch ${b + 1}/${batches.length} — ${rows.length - sent} left for retry`; console.warn(`[deliver-signals:${source}] webhook ${m}`); dbRecordDelivery(source, false, m); break; }
      markSignalsDelivered(batch.map((r) => Number(r.id)));   // one transaction, not one fsync per row
      sent += items.length;
      if (b < batches.length - 1) await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      const m = `${(e as Error).message} — will retry next cycle`; console.warn(`[deliver-signals:${source}] webhook error on batch ${b + 1}: ${m}`); dbRecordDelivery(source, false, m);
      break;
    }
  }
  if (sent >= rows.length) dbRecordDelivery(source, true, `delivered ${sent}`);
  return sent;
}

/**
 * Which webhook a signal type goes to. Extracted and exported because getting this wrong sends one
 * customer's funding alerts to another customer's endpoint, and inline in the loop below there was
 * no way to test the precedence at all.
 *
 * Lookup order is legacy-first so no existing config silently reroutes when categories landed:
 * legacy family → exact type → CATEGORY (the new, preferred key) → the client's default webhook.
 * "" means no sink: the signal is dashboard-only and gets marked delivered.
 *
 * Own-property lookups only. `routes` is parsed from the client's YAML, so a key of "constructor"
 * or "toString" would otherwise resolve to a function off Object.prototype, and `.trim()` on it
 * throws mid-delivery — taking down the whole cycle for every other signal in the batch.
 */
export function resolveSignalRoute(type: string, routes: Record<string, string>, defaultHook: string): string {
  const own = (k: string): string | undefined =>
    (Object.prototype.hasOwnProperty.call(routes, k) ? routes[k] : undefined);
  const hook = own(legacyFamily(type)) ?? own(type) ?? own(categoryOf(type)) ?? defaultHook;
  return String(hook ?? "").trim();
}

export async function deliverSignals(client: ClientConfig): Promise<number> {
  const rows = getUndeliveredSignals(client.name);
  if (!rows.length) return 0;
  // The read is capped. Say so rather than letting a truncated cycle read as "that was everything" —
  // the remainder goes out on the next cycle, which is a fact the operator should see, not infer.
  if (rows.length >= SIGNAL_BACKLOG_CAP) {
    const left = countUndeliveredSignals(client.name) - rows.length;
    console.log(`[deliver-signals:${client.name}] backlog capped at ${SIGNAL_BACKLOG_CAP} this cycle — ${left} still queued`);
  }
  const defaultHook = (client.delivery?.webhook_url ?? "").trim();
  const routes = client.signal_webhooks ?? {};
  // Route each signal to its family-specific webhook (else the exact type, else the default). Signals
  // with no matching sink are marked delivered (dashboard-only). Group by target so each webhook batches.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const unrouted: number[] = [];
  for (const r of rows) {
    const hook = resolveSignalRoute(String(r.type), routes, defaultHook);
    if (!hook) { unrouted.push(Number(r.id)); continue; }
    const g = groups.get(hook) ?? []; g.push(r); groups.set(hook, g);
  }
  markSignalsDelivered(unrouted);  // dashboard-only signals: one transaction, not one per row
  let sent = 0;
  for (const [hook, grp] of groups) sent += await postSignalRows(hook, grp, client.name);
  return sent;
}

/** Deliver a one-off check's new signals to its optional webhook (the "One-off checks can POST too"
 *  path). No webhook → mark delivered (dashboard/CSV only). */
export async function deliverCheckSignals(checkId: string, webhook: string | undefined): Promise<number> {
  const rows = getUndeliveredCheckSignals(checkId);
  if (!rows.length) return 0;
  const hook = (webhook ?? "").trim();
  if (!hook) { markSignalsDelivered(rows.map((r) => Number(r.id))); return 0; }
  return postSignalRows(hook, rows, `check:${checkId.slice(0, 8)}`);
}

/**
 * Deliver anything a previous run left behind, at boot.
 *
 * deliver() for MATCHES is called from exactly one place — the end of a successful fetch
 * (ingest.ts). So a fetch that is interrupted part-way persists its matches and never delivers
 * them, and the only thing that will ever pick them up is that same client's NEXT completed fetch.
 * Nothing surfaces the backlog: the dashboard shows the matches (it reads the matches table, not the
 * delivered flag), so the app looks entirely healthy while the webhook never receives them.
 *
 * This is not a rare edge. The app quits itself when the dashboard closes, and interruption is the
 * normal way a run ends: on the live database 5 of the 11 recorded fetch runs are marked
 * "interrupted — the app stopped before this run finished". One of them left 933 matches for a
 * realtime client undelivered, and because that client's schedule is "09:00 daily" and the app is
 * rarely running at 09:00, they had been sitting there for five days.
 *
 * db.ts already reconciles those interrupted RUNS at boot (reconcileOrphanedRuns) — it relabels the
 * run row and stops there. This is the other half: reconcile the WORK the interrupted run produced.
 * It sits alongside resumeAccountChecks(), which is the same idea for a different kind of work.
 *
 * REALTIME CLIENTS ONLY, deliberately. Their contract is "send it as soon as we have it", so a
 * queued match is unambiguously late. A scheduled client's contract is "send it at the digest time",
 * and flushing at boot would break that promise rather than keep it — their backlog is the digest
 * cron's to own.
 *
 * Nothing new is invented here: deliver()/deliverSignals() are the same functions the fetch path
 * calls, with the same batching, the same 2xx-gated marking and the same stop-on-first-failure. The
 * only thing that changes is WHEN they run, so a webhook that is down at boot simply leaves the
 * backlog queued exactly as it does today.
 */
export async function flushPendingDeliveries(clients: ClientConfig[]): Promise<void> {
  for (const client of clients) {
    if (client.active === false || !isRealtime(client)) continue;
    const matches = countUndelivered(client.name);
    const signals = countUndeliveredSignals(client.name);
    if (!matches && !signals) continue;
    // Say what is being retried and why. A silent flush of a five-day-old backlog looks, from the
    // receiving end, like a burst of duplicates with no explanation.
    console.log(`[deliver] ${client.name}: ${matches} match(es) + ${signals} signal(s) left undelivered by an earlier run — sending now`);
    // A BOOT-SAFETY BACKSTOP, and worth being precise about what it does and does not do. An
    // unreachable webhook is already handled inside deliver() itself, which logs, records the
    // failure and returns — it does not throw, and a mutation test confirms removing this catch
    // changes nothing for that case. What is left is everything else: a DB error, a malformed
    // stored config, a bug in a batch. Those would otherwise escape into the boot sequence and take
    // the dashboard down with them, for a backlog that is safely queued on disk either way.
    try { if (matches) await deliver(client); }
    catch (e) { console.error(`[deliver] ${client.name}: match backlog failed — ${(e as Error).message} (still queued; the next fetch retries)`); }
    try { if (signals) await deliverSignals(client); }
    catch (e) { console.error(`[deliver] ${client.name}: signal backlog failed — ${(e as Error).message} (still queued)`); }
  }
}
