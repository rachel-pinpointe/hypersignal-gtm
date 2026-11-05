<div align="center">

<img src="../web/logo.svg" alt="" width="64" height="64">

# HyperSignal

**Watch companies. See what changed. Reach them while it still matters.**

A sales-signal radar that runs on your own machine. Give it a list of companies you sell to, and
it tells you when something moves: they started hiring, raised money, switched tools or laid
people off. You see it on a dashboard and over webhooks.

Every source it reads is free and public.

[![Release](https://img.shields.io/badge/release-alpha%201-0f766e)](#project-status)
[![Licence](https://img.shields.io/badge/licence-Apache%202.0-0f766e)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-0f766e)](#requirements)

[hypersignal-site.vercel.app](https://hypersignal-site.vercel.app)

</div>

---

## What it watches

Give it company domains. Thirteen independent readings run against each one, producing 27 kinds of
signal, grouped here into the eight things you would actually act on.

| | |
|---|---|
| **Hiring** | Every open role, across ~40 job boards and applicant-tracking systems at once |
| **Hiring velocity** | Posting accelerating, a genuinely new location, a role advertised over and over |
| **Funding** | SEC filings, UK Companies House filings, funding news worldwide |
| **Layoffs** | Official WARN notices |
| **Tooling** | Website tech-stack changes, DNS and email-tool changes, a switch of hiring system |
| **Growth** | New subdomains, mobile apps published or gone stale, Product Hunt launches |
| **Marketing** | Meta ad activity starting or stopping |
| **News** | Company news, expansions, leadership changes, partnerships |

Each one works two ways:

- **Watch continuously.** It re-checks on a schedule and reports only what *changed* since last
  time, so a brand-new list doesn't bury you in history.
- **Check once.** Upload a CSV of domains, get a facts grid, export it. No monitoring, no waiting.

## Why it costs nothing to run

It reads public pages and open data: job boards, SEC EDGAR, Companies House, GDELT, Google News,
state WARN registries, the App Store and Google Play, Product Hunt, the Meta Ad Library, and
companies' own websites and careers pages.

No account to create, no key to buy, no proxies. One optional source, UK Companies House, takes a
free API key if you want it. Everything else works without one.

## Requirements

**Node 22.5 or newer.** It stores data in SQLite through Node's own built-in driver, which arrives
in 22.5. macOS, Linux and Windows.

## Run it

```bash
git clone https://github.com/athm793/HyperSignal-Hiring.git
```
```bash
cd HyperSignal-Hiring && npm install && npm start
```

Then open **http://localhost:4000**.

Nothing is fetched until you add a monitor and either press Fetch or let its schedule fire.

```bash
npm run cycle
```
Runs one fetch cycle and exits, without starting the dashboard. Useful from a cron job.

## Where your data lives

On your machine. Everything goes into one SQLite file at `data/signals.db`, and the companies you
watch are plain YAML in `clients/`. There is no service behind this, no telemetry and no account,
and the dashboard binds to localhost.

The only thing that leaves your machine is what you configure yourself: webhook deliveries, to URLs
you enter. Their exact payloads are documented in [`docs/webhooks.md`](webhooks.md).

## If jobs show up in the Jobs database but not under Monitoring

Those two screens read different things: the Jobs database shows every stored posting, while the
monitoring tabs show only postings a monitor claimed. Several different causes look identical on
screen, so there is a script that names the one you actually hit.

```bash
node scripts/diagnose-monitors.mjs
```

It reads the database read-only, prints your monitors and what each one can match, and for recent
unmatched jobs says which rule rejected them.

## Configuring it

Most of it happens in the dashboard. Beyond that, `.env.example` lists every environment variable
the code reads, each commented out and showing its real default, so an untouched copy changes
nothing. Copy it to `.env` and uncomment only what you want to change.

## Project status

**Alpha 1.** It runs daily against real data and everything above works. The shape of it, plainly:

- It runs **on your computer**, not a server. Close the laptop and scheduled checks stop until you
  open it again.
- Several signals are **best-effort by nature.** They read public pages that can change shape or
  rate-limit. When a reading fails, the app reports that it could not tell, rather than a confident
  "no". That distinction is deliberate and load-bearing throughout.
- Reading each company's own job board is optional and **slow to start**: every company is checked
  once before the first job is fetched. The app says so where you switch it on.
- One monitor watches up to **10,000 companies**. Past that, split it. It refuses rather than
  quietly dropping the rest.

## Contributing

Issues and pull requests welcome. Two things worth knowing:

- `npm test` and `npm run typecheck` both have to pass.
- Tests here pin behaviour that was **measured**, not assumed. If you fix a bug, its test should
  fail when the fix is reverted.

## Licence

[Apache 2.0](../LICENSE). Commercial use, modification and distribution permitted, with an explicit
patent grant.
