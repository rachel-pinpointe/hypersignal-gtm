# Webhook payloads

Every monitor can POST what it finds to a URL you provide. This is the exact shape of what arrives.
Extracted verbatim from the README so the reference stays complete without the README carrying it.


There are **two** payloads, versioned independently. Branch on the `event` field (also sent as the
`X-HyperSignal-Event` header):

| Event | Schema | What it is |
|---|---|---|
| `matches.new` | `schema_version: 2` | new job matches from a client search / watchlist / account check |
| `signals.new` | `schema_version: 1` | new company signals from the 13 producers |

### `matches.new` — new job matches

Payload **schema v2** (`schema_version: 2`, also sent as the `X-HyperSignal-Schema` header).
Each signal carries the rich hiring.cafe data when available — company domain, salary, seniority,
company firmographics, and job-description content — so it's an actionable signal, not just a title +
link. The full scraped `description` is present for org/watchlist + account-check matches; every
hiring.cafe signal also carries the structured `requirements_summary` + `role_activities` (free, from
the results payload). Enrichment fields are `null` for local-source (Craigslist/SimplyHired) jobs.

```json
{
  "event": "matches.new",
  "schema_version": 2,
  "client": "hire4less",
  "delivery_id": "1f9c…",
  "batch": { "index": 1, "total": 1, "size": 100 },
  "count": 12,
  "total_count": 12,
  "signals": [
    {
      "id": "...", "title": "Customer Support Specialist", "company": "Acme Co",
      "company_domain": "acme.com",
      "location": "Austin, TX, United States", "state": "TX", "remote": false,
      "status": "open", "url": "https://jobs.acme.com/cs-specialist", "source": "hiringcafe",
      "posted_at": "2026-06-24T00:00:00.000Z", "first_seen_at": "2026-06-25T09:55:33.712Z",
      "matched_at": "2026-06-25T09:55:34.001Z",
      "match_reason": "corporate · geo:TX",
      "technologies": ["React", "Kubernetes"],
      "description": "Full scraped JD text — present for org/watchlist + account-check matches…",
      "requirements_summary": "…", "role_activities": "…",
      "seniority": "Entry Level", "years_experience_min": 0, "job_category": "Customer Service",
      "commitment": "Full Time", "workplace_type": "Onsite",
      "visa_sponsorship": false, "security_clearance": "None",
      "compensation": { "min": 45000, "max": 55000, "currency": "USD", "period": "yearly" },
      "company_info": { "industry": "Software", "employees": 320, "founded": 2014,
                        "org_type": "private", "funding_type": "series b", "funding_year": 2022 }
    }
  ]
}
```

`count` is signals in this batch; `total_count` is the whole delivery. `posted_at` can be
null (some sources don't expose it), so each signal also carries **`first_seen_at`** — when
we first ingested it — as a reliable fallback timestamp. `status` is `open`/`closed`.

**Nullable fields to handle.** `compensation.currency` **can be `null`** — we deliver the currency
the source actually stated and never substitute `"USD"`, because an invented currency writes a wrong
number into a CRM and nobody catches it. Treat a null currency as "amount known, unit unknown".
`compensation` itself is null when no pay was published, and `posted_at`, `company_domain`,
`description` and every enrichment field can be null too.

**`source` values.** The payload carries a **coarsened** source, not the raw database value:
`delivery.ts` keeps only the part before the first colon and folds `hcorg` into `hiringcafe`. So the
complete set a webhook consumer can ever receive is these six, and **plain equality is correct** —
you will never see a city or an ATS vendor here:

| Value in the payload | Covers |
|---|---|
| `hiringcafe` | a hiring.cafe keyword search **and** a company pulled by domain via `/org/<domain>` (stored as `hcorg`, delivered as `hiringcafe`) |
| `ats` | any direct ATS board — the vendor and company slug are stripped |
| `craigslist` | Craigslist — the city is stripped |
| `simplyhired` | SimplyHired |
| `remoteok` | the free RemoteOK feed |
| `weworkremotely` | the free WeWorkRemotely feed |

The finer-grained originals (`hcorg`, `craigslist:<city>`, `ats:<vendor>:<slug>` — vendors
`greenhouse`, `lever`, `ashby`, `workable`, `recruitee`, `smartrecruiters`, `personio`) exist ONLY in
the `raw_jobs.source` column. Both the webhook **and both CSV exports** coarsen it through the same
`publicSource()` helper (`src/payload.ts`), so a rule keyed on `ats:greenhouse` or `craigslist:austin`
matches nothing in a downloaded file. This paragraph previously claimed the CSV kept the detail; it
does not, and never did — query the database directly if you need the vendor.

### `signals.new` — new company signals

Payload **schema v1** (`schema_version: 1`, `X-HyperSignal-Event: signals.new`). This is what all 13
producers emit, delivered per client/watchlist and batched the same way as `matches.new`.

```json
{
  "event": "signals.new",
  "schema_version": 1,
  "client": "target-accounts",
  "delivery_id": "8ad2…",
  "batch": { "index": 1, "total": 1, "size": 100 },
  "count": 3,
  "total_count": 3,
  "signals": [
    {
      "signal_type": "funding-form-d",
      "signal_category": "funding",
      "evidence_rank": 100,
      "title": "Raised (Form D) — filed 2026-07-15",
      "company": "Globex", "company_domain": "globex.com",
      "url": "https://www.sec.gov/Archives/edgar/data/…",
      "detail": { "form": "D", "date": "2026-07-15", "accession": "0001234567-26-000123", "cik": "0001234567" },
      "observed_at": "2026-07-15",
      "first_seen_at": "2026-07-16T04:12:08.551Z"
    }
  ]
}
```

- **`signal_type`** is the exact producer-specific type and never changes value — branch on it
  safely. All **27** current types:

  | | | |
  |---|---|---|
  | `velocity-spike` | `velocity-location` | `velocity-repost` |
  | `dns-mx-changed` | `dns-tool-added` | `dns-tool-removed` |
  | `ats-switched` | `tech-added` | `tech-removed` |
  | `subdomain-new` | `funding-form-d` | `filing-8k` |
  | `filing-s1` | `ch-share-allotment` | `app-published` |
  | `app-stale` | `news-funding` | `news-layoffs` |
  | `news-leadership` | `news-expansion` | `news-partnership` |
  | `news-launch` | `gdelt-funding` | `warn-layoff` |
  | `ph-launch` | `ads-started` | `ads-stopped` |

  The authoritative list — every type with its label, category and evidence rank — lives in
  `src/signals/taxonomy.ts` and is served live at **`GET /api/signals/taxonomy`**. Read it from
  there rather than hard-coding this table if you want to stay current.
- **`signal_category`** is the cross-source *meaning*, so one branch handles a raise however it was
  found: a US Form D, a UK SH01 and a press report all carry `"funding"`. Categories: `funding`,
  `corporate`, `layoffs`, `launch`, `expansion`, `hiring`, `leadership`, `partnership`, `tooling`,
  `marketing`, `quiet`, `other`.
- **`evidence_rank`** says how hard the evidence is: official filing `100` > our own direct
  observation `70` > curated feed `40` > press `20` > unknown `10`. Use it to decide whether to act
  or wait for confirmation.
- **How the signal was attached to the company** is a separate question from how strong it is, and
  the taxonomy answers it per type (`attribution`, served at `GET /api/signals/taxonomy`).
  `direct` (14 types) means we observed the company's OWN domain — DNS, their site, their job
  boards, their app or ad listings — so there is nothing to mis-attribute. `name` (13 types) means
  we searched a third-party corpus for the company's NAME: news, GDELT, SEC EDGAR, UK Companies
  House, state WARN lists, Product Hunt. The matchers are deliberately conservative (whole-word for
  free text, prefix-anchored for registry names), but a name match can still be wrong, and the
  dashboard labels those rows "name match" for that reason. Treat a `name` signal as a lead to
  confirm, not a fact.
- `detail` is producer-specific JSON (or `null`); `url`, `company`, `company_domain` and
  `observed_at` can be null. `first_seen_at` is always present, and always a full ISO instant.
- **`observed_at` is passed through EXACTLY as the source supplied it — parse it defensively.** It
  is the event's own date, not a timestamp we generate, so its shape follows the source: SEC EDGAR
  and state WARN lists give a bare `YYYY-MM-DD` (no time, no zone), while news and GDELT items
  carry a full instant. A consumer that assumes ISO-8601-with-zone will mis-parse the filing dates,
  which are exactly the ones worth acting on. Sort and compare on the DATE.
- **Additive-only under v1:** new fields may appear without a version bump. Renaming or removing one
  requires `schema_version: 2`. The feed's on-screen grouping of duplicate reports is a *display*
  feature only — webhooks always deliver every signal individually.

Point `delivery.webhook_url` at a Slack incoming webhook, an LGM/Sendkit inbox
webhook, or Zapier/Make — no code change.
