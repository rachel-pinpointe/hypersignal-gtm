// Classify tables for the two headline-driven producers. The app now fetches local-language Google
// News editions and GDELT's worldwide index, so a headline in German or Japanese has to classify the
// same as its English equivalent — otherwise we pay for the fetch and file everything under "other".
// Run: npx tsx --test src/signals/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./news.ts";
import { looksLikeFunding } from "./gdelt.ts";

const NEWS: Array<[string, string]> = [
  // English (the pre-existing behaviour — must not regress)
  ["Ramp raises $150M Series D", "news-funding"],
  ["Acme lays off 200 staff", "news-layoffs"],
  ["Acme appoints new CFO", "news-leadership"],
  ["Acme partners with Stripe", "news-partnership"],
  ["Acme opens a new office in Denver", "news-expansion"],
  ["Acme launches in Germany", "news-expansion"],   // capitalised country → expansion, not launch
  ["Acme unveils new AI platform", "news-launch"],
  ["Acme wins industry award", "news-other"],       // unclassified stays unclassified
  // German
  ["Acme schließt Finanzierungsrunde über 20 Millionen Euro ab", "news-funding"],
  ["Acme kündigt Stellenabbau an", "news-layoffs"],
  ["Acme ernennt neuen Finanzvorstand", "news-leadership"],
  ["Acme expandiert nach Österreich", "news-expansion"],
  // French / Spanish / Italian / Dutch
  ["Acme lève des fonds pour son expansion", "news-funding"],
  ["Acme annonce une levée de fonds de 10 millions", "news-funding"],
  ["Acme despide a 100 empleados", "news-layoffs"],
  ["Acme se asocia con Telefónica", "news-partnership"],
  ["Acme apre una sede a Milano", "news-expansion"],
  ["Acme haalt 5 miljoen op bij investeerders", "news-funding"],
  // Japanese / Korean
  ["Acmeが10億円を調達", "news-funding"],
  ["Acme、人員削減を発表", "news-layoffs"],
  ["Acme 시리즈 B 투자 유치", "news-funding"],
];

test("news headlines classify the same in every supported language", () => {
  for (const [title, want] of NEWS) {
    assert.equal(classify(title), want, `"${title}" should be ${want}, got ${classify(title)}`);
  }
});

test("GDELT funding filter accepts real funding headlines worldwide", () => {
  for (const t of [
    "Acme raises $40M Series B",
    "Acme lève 12 millions d'euros",
    "Acme schließt Finanzierungsrunde ab",
    "Acme capta 8 millones en una ronda de inversión",
    "Acmeが20億円を調達",
    "Acme, 시리즈 C 투자 유치",
    "Acme 完成 A 轮融资",
    "Acme raises ₹500 crore",
  ]) assert.equal(looksLikeFunding(t), true, `should match: ${t}`);
});

test("GDELT funding filter rejects non-funding headlines", () => {
  for (const t of [
    "Acme opens a new office in Berlin",
    "Acme appoints a new CTO",
    "Acme wins design award",
    "Acme ernennt neuen Geschäftsführer",
  ]) assert.equal(looksLikeFunding(t), false, `should NOT match: ${t}`);
});

// ---- Launch false positives found in the live feed --------------------------------------------
// `releases?` and `debuts?` are the only verbs in the launch group that are also very common NOUNS,
// and both were misfiring on real headlines the app had already filed:
//   "Webster Financial Corporation Announces Q2 2026 Earnings Release" -> filed as a product launch
//   "Beau Webster Debut and last played matches in Tests, ODIs, T20Is" -> filed as a product launch
// The second is a cricketer; the company is a bank. Acting on either wastes an outreach, and a feed
// that cries "launch" at earnings calendars trains the reader to ignore the signal entirely.
test("an earnings/press release is not a product launch", () => {
  for (const t of [
    "Webster Financial Corporation Announces Q2 2026 Earnings Release",
    "Acme Corp Issues Press Release on Board Changes",
    "Globex Q3 Results Release Scheduled for Tuesday",
    "Initech Annual Release of Financial Statements",
  ]) assert.notEqual(classify(t), "news-launch", `should not be a launch: ${t}`);
});

test("a sporting or entertainment debut is not a product launch", () => {
  for (const t of [
    "Beau Webster Debut and last played matches in Tests, ODIs, T20Is",
    "Singer announces debut album for the autumn",
    "Director's debut film premieres at Cannes",
  ]) assert.notEqual(classify(t), "news-launch", `should not be a launch: ${t}`);
});

test("but genuine launches still classify — the guards must not overshoot", () => {
  for (const t of [
    "Cloudflare launches superior CAPTCHA alternative",
    "Acme releases its new analytics platform",          // "releases" with no financial prefix
    "Globex debuts a redesigned mobile app",             // "debuts" as a verb, no media noun after
    "Initech to debut its new pricing engine",           // verb form with an auxiliary
    "Initech unveils Precursor for bot detection",
    "Stripe introduces instant payouts",
  ]) assert.equal(classify(t), "news-launch", `should be a launch: ${t}`);
});
