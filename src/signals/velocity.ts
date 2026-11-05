// Hiring-velocity signals — derived from the postings already collected for a domain (no fetching).
//
// HONESTY RULE: we only know what we've scraped since we started watching a company, not its real
// hiring history. So a signal only fires when it can't be an artifact of when we started:
//   • We require a real BASELINE — at least MIN_BASELINE_DAYS of collection for the domain (from the
//     earliest seen_at). Below that, a "quiet prior month" just means "we weren't looking yet", so we
//     stay silent rather than claim a spike or a new location.
//   • velocity-spike fires only against a NON-ZERO prior month (prior30 >= 2) — never "was 0", which
//     was always really "no data". It's a genuine acceleration over a measured base.
//   • velocity-location requires the (normalized) location to be genuinely new across the whole
//     baseline window — not merely a string variant of one we already had.
//   • velocity-repost is an OBSERVABLE FACT (same title posted 3+ times) — valid regardless of history.
// "First hire in a function" was removed: we can't know a company's first hire from a partial sample.
import { db } from "../db.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const DAY = 86400e3;
const MIN_BASELINE_DAYS = 60;   // need this much collection history before rate/location claims are honest

// Detect job function for the descriptive "Functions hiring" fact (NOT used to claim a first hire).
const FUNCTIONS: Array<[string, RegExp]> = [
  ["sales", /\b(sales|account executive|sdr|bdr|business development|revenue)\b/i],
  ["marketing", /\b(marketing|growth|demand gen(eration)?|seo|content|brand|social media)\b/i],
  ["engineering", /\b(engineer|developer|devops|sre|architect|programmer)\b/i],
  ["hr", /\b(recruit(er|ing)?|talent|people ops|human resources|hr generalist)\b/i],
  ["support", /\b(support|customer success|customer service|help ?desk)\b/i],
  ["finance", /\b(finance|accountant|controller|bookkeep|payroll)\b/i],
];

// US state full-name → USPS code, so "Austin, TX" and "Austin, Texas" canonicalize to the same place.
const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
/** Canonical "city|ST" key from a raw hiring.cafe location ("Austin, TX, United States"). */
function locKey(raw: string): string | null {
  const parts = raw.toLowerCase().replace(/\bunited states( of america)?\b|\busa\b|\bu\.s\.a?\.?\b/g, "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const city = parts[0]!;
  let region = parts[1] ?? "";
  region = STATE_ABBR[region] ?? region.toUpperCase();
  return region ? `${city}|${region}` : city;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export const velocityProducer: SignalProducer = {
  key: "velocity",
  label: "Hiring velocity",
  description: "Posting acceleration, genuinely-new locations, and chronic reposts — from postings we've collected. Rate/location signals require 60+ days of history so they're not artifacts of when we started watching.",
  flagged: true,
  async check(domain): Promise<ProducerResult> {
    const rows = db.prepare(
      // `url` rides along so the repost signal can point at the posting it is about — see the group
      // below. It costs nothing here: the same rows are already being read.
      `SELECT title, location, status, url, COALESCE(posted_at, seen_at) AS at, seen_at AS seen FROM raw_jobs WHERE domain = ?`,
    ).all(domain) as Array<{ title: string; location: string | null; status: string | null; url: string | null; at: string; seen: string }>;
    // "We have no postings for this domain" is a DEFINITIVE answer to "are they hiring hard?" — no —
    // and it is answered from our own table, so it can never be a failed lookup. Returning no flag
    // filed the company as UNKNOWN instead: absent from the "hiring hard" filter and absent from its
    // negative, with no chip in the Companies "Why now" column saying so. 1,146 of the 1,280 domains
    // on the live watchlist land here, so the velocity filter was effectively answering for 134.
    if (!rows.length) return { facts: { "Jobs on record": "0" }, signals: [], flag: { hit: false, summary: "No postings on record" } };

    const now = Date.now();
    const ts = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
    const open = rows.filter((r) => r.status !== "closed").length;
    const last30 = rows.filter((r) => now - ts(r.at) <= 30 * DAY);
    const prior30 = rows.filter((r) => { const a = now - ts(r.at); return a > 30 * DAY && a <= 60 * DAY; });
    // How long we've actually been collecting this domain (earliest ingest) — the honesty anchor.
    const trackingSince = Math.min(...rows.map((r) => ts(r.seen)));
    const trackingDays = (now - trackingSince) / DAY;
    const hasBaseline = trackingDays >= MIN_BASELINE_DAYS;
    const fnHits = FUNCTIONS.filter(([, re]) => rows.some((r) => re.test(r.title))).map(([fn]) => fn);
    const signals: SignalDraft[] = [];

    // Posting acceleration — only against a real, non-zero prior month, and only with enough history.
    // (No "was 0": a zero prior month is indistinguishable from "we weren't watching".)
    if (hasBaseline && prior30.length >= 2 && last30.length >= 3 * prior30.length) {
      const month = new Date().toISOString().slice(0, 7);
      signals.push({
        dedupKey: `velocity-spike:${domain}:${month}`, type: "velocity-spike",
        title: `Hiring accelerating: ${last30.length} roles in 30d vs ${prior30.length} the month before`,
        detail: { last30: last30.length, prior30: prior30.length, trackingDays: Math.round(trackingDays) },
      });
    }

    // Genuinely-new location — normalized, and unseen across the ENTIRE baseline window (not just >30d).
    if (hasBaseline) {
      const firstSeenByLoc = new Map<string, { earliest: number; display: string }>();
      for (const r of rows) {
        const raw = (r.location ?? "").trim();
        if (!raw || /remote/i.test(raw)) continue;
        const key = locKey(raw); if (!key) continue;
        const cur = firstSeenByLoc.get(key);
        if (!cur || ts(r.at) < cur.earliest) firstSeenByLoc.set(key, { earliest: ts(r.at), display: raw });
      }
      for (const [key, { earliest, display }] of firstSeenByLoc) {
        if (now - earliest <= 30 * DAY) { // first EVER appearance (in our record) is within the last month
          signals.push({
            dedupKey: `velocity-location:${domain}:${slug(key)}`, type: "velocity-location",
            title: `New hiring location: ${display} — first seen this month`,
            detail: { location: display, trackingDays: Math.round(trackingDays) }, observedAt: new Date(earliest).toISOString(),
          });
        }
      }
    }

    // Chronic repost — the SAME role at the SAME place, advertised again and again OVER TIME.
    //
    // This used to count rows sharing a title, anywhere, on any date. That is not reposting, it is
    // parallel hiring, and for a logistics company it is most of the job board. Measured on the live
    // data, every top "repost" was the opposite of the claim:
    //   "Reposted 7×: CDL-A Driver — likely struggling to fill"
    //   = 7 seats, 4 different cities, ALL still open, ALL posted on ONE day.
    // A company opening seven driver seats across four cities in a day is expanding, not failing to
    // hire. 876 of 1,255 signals in the feed — 70% — were this. It made the single loudest signal in
    // the product an inverted one, and it aimed it hardest at exactly the multi-site employers a
    // logistics watchlist is made of.
    //
    // A genuine repost needs three things, and the old rule had none of them:
    //   • same LOCATION   — otherwise parallel seats in different cities read as one role
    //   • distinct DATES  — otherwise one batch of postings reads as many attempts
    //   • a real SPAN     — otherwise a burst inside one week reads as chronic
    // Requiring a CLOSED earlier posting would be stronger still, and was measured: it yields zero,
    // because jobs are only marked closed after 14 days of not being seen. On a young install that
    // would silence the signal completely, so span is the honest proxy.
    //
    // Effect on the same snapshot: 664 role-groups qualified under the old rule, 55 under this one.
    // The survivors are unambiguous — a UPS "Customer Associate" in India posted on 9 distinct dates
    // across 56 days, an "Analyst" in Irvine on 9 dates across 156 days.
    const REPOST_MIN_POSTINGS = 3;   // distinct posting DATES, not rows
    const REPOST_MIN_SPAN_DAYS = 21; // a burst inside three weeks is a batch, not a chronic problem
    const byRole = new Map<string, { title: string; loc: string; days: Set<string>; first: number; last: number; lastUrl: string | null }>();
    for (const r of rows) {
      const t = slug(r.title);
      if (!t) continue;
      const at = ts(r.at);
      if (!isFinite(at)) continue;
      // locKey normalises "Nuevo Laredo, Tamaulipas, Mexico" and "Nuevo Laredo, TAMAULIPAS, Mexico"
      // onto one key — without it those split into two groups and neither reaches the threshold.
      const key = `${t}@${locKey(r.location ?? "") ?? ""}`;
      let g = byRole.get(key);
      if (!g) { g = { title: r.title, loc: r.location ?? "", days: new Set(), first: at, last: at, lastUrl: r.url ?? null }; byRole.set(key, g); }
      g.days.add(new Date(at).toISOString().slice(0, 10));
      if (at < g.first) g.first = at;
      // Keep the NEWEST posting's link, not the first one seen. The earliest of a chronic repost is
      // the one most likely to be closed and delisted by now, and a signal that says "they are still
      // trying to fill this" must not open a dead page — that reads as the opposite of the claim.
      if (at >= g.last) { g.last = at; g.lastUrl = r.url ?? g.lastUrl; }
    }
    for (const [key, g] of byRole) {
      const spanDays = Math.round((g.last - g.first) / DAY);
      if (g.days.size < REPOST_MIN_POSTINGS || spanDays < REPOST_MIN_SPAN_DAYS) continue;
      signals.push({
        // Key includes the location now, so the same title at two sites is two findings rather than
        // one — and an old-format key can never suppress a correct new one.
        dedupKey: `velocity-repost:${domain}:${key}`, type: "velocity-repost",
        title: `Reposted ${g.days.size}× over ${spanDays} days: "${g.title}"${g.loc ? ` (${g.loc})` : ""} — likely struggling to fill`,
        // A signal about ONE specific posting should open that posting. All 54 stored repost signals
        // carry no link at all, so "reposted 9 times over 156 days" is a claim the reader cannot
        // check without going and searching for the role themselves — and it is the claim most worth
        // checking, because it is the one an operator would actually open a conversation with.
        url: g.lastUrl,
        detail: { title: g.title, location: g.loc || null, postings: g.days.size, spanDays },
      });
    }

    const trackingLabel = trackingDays >= 1 ? `${Math.round(trackingDays)}d` : "just added";
    return {
      facts: {
        "Jobs on record": String(rows.length),
        "Open roles": String(open),
        "Posted last 30d": String(last30.length),
        "Tracking for": trackingLabel + (hasBaseline ? "" : " (rate/location signals need 60d)"),
        ...(fnHits.length ? { "Functions hiring": fnHits.join(", ") } : {}),
      },
      signals,
      // "Heavily hiring right now": 5+ roles posted in the last 30 days (every tracked company has some
      // jobs, so a threshold distinguishes the active hirers worth filtering to).
      flag: { hit: last30.length >= 5, summary: `${last30.length} roles posted in the last 30d` },
    };
  },
};
