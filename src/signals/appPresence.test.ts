// Which App Store result counts as THIS company's app.
//
// Ownership is a property of the SELLER, not of the app's title — anyone may call an app anything.
// The old test accepted a result on any of three arms (seller contains company, company contains
// seller, app name starts with company), none word-bounded and none with a length floor. Of the 14
// app-stale signals on the live feed, 10 were about an unrelated app.
//
// Every seller string below is the REAL sellerName the iTunes Search API returned for that company,
// captured while investigating. The selection rule is reproduced here rather than exported, because
// what needs pinning is the DECISION, and the fetch around it is not worth a network fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCompanyApp, type StoreApp } from "./appPresence.ts";

// The REAL function, imported. An earlier version of this file re-implemented the rule instead, and
// replacing the matcher in the source with  left every test green.
type App = StoreApp;
const pick = (company: string, results: App[]): App | undefined => pickCompanyApp(company, results);

test("an app published by someone else is not this company's app", () => {
  // All five were live signals. The publisher gives each one away.
  assert.equal(pick("Airgroup", [{ trackName: "Airgroup: All In One Gym", sellerName: "HOTSOFT TECHNOLOGY" }]), undefined,
    "a freight forwarder does not publish a gym app");
  assert.equal(pick("Fcbf", [{ trackName: "FCBF Church", sellerName: "CHRISTIAN FREEDOM BIBLE FELLOWSHIP" }]), undefined,
    "the app NAME starting with the company is not evidence — the old rule's third arm");
  assert.equal(pick("Compass Forwarding Co. Inc", [{ trackName: "Compass & Altimeter", sellerName: "明力 王" }]), undefined,
    "published by an individual, and 'Compass Forwarding' is not a prefix of anything here");
  assert.equal(pick("Counselor", [{ trackName: "ASCA School Counselor", sellerName: "American School Counselor Association" }]), undefined,
    "a prefix must start the name — 'counselor' appears at the END of the seller");
  assert.equal(pick("EgeTrans", [{ trackName: "Egetrans Yolcu", sellerName: "Kursat Celik" }]), undefined);
});

test("an app published by the company IS the company's app", () => {
  assert.deepEqual(pick("Alpi USA", [{ trackName: "ALPI Tracker", sellerName: "Alpi USA, Inc." }])?.trackName, "ALPI Tracker");
  assert.deepEqual(pick("R+L Carriers", [{ trackName: "R+L Carriers", sellerName: "R&L Carriers, Inc" }])?.trackName, "R+L Carriers");
});

test("the CLOSEST seller wins, not the first one that matches", () => {
  // Both sellers legitimately entity-match, and the API returns the less specific one first. Taking
  // the first attributed MAKIRA to the wrong NTT DATA entity.
  const results: App[] = [
    { trackName: "NTT DATA Services Events", sellerName: "NTT DATA Inc" },
    { trackName: "MAKIRA", sellerName: "NTT DATA Business Solutions AG" },
  ];
  assert.equal(pick("NTT DATA Business Solutions", results)?.trackName, "MAKIRA");
});

test("no candidate at all yields nothing rather than the top search result", () => {
  assert.equal(pick("NTT DATA Business Solutions", [{ trackName: "MAKIRA", sellerName: "Unrelated Studio" }]), undefined);
  assert.equal(pick("Acme Logistics", []), undefined);
});

// ── Which Android app the verdict was standing on ───────────────────────────────────────────────
//
// The Android arm stored the string "1" and nothing else. "This company has an Android app" was
// therefore a claim with no package, no name and no link behind it — unfalsifiable. The iOS arm
// stores the id, title and URL, which is the only reason a later pass could re-check 65 iOS
// attributions against Apple and find 20 wrong: a freight forwarder credited with a church app, a
// basketball app, a Target retail app, an undead-defense game. The 46 Android attributions could not
// be checked at all, and the repair script had to report the number and move on.
//
// The HTML fragments below are the real shapes read off play.google.com while investigating.
import { pickAndroidPackage } from "./appPresence.ts";

const page = (...ids: string[]) => ids.map((i) => `<a href="/store/apps/details?id=${i}">`).join("");

test("the package that names the company wins, even when it is not the first result", () => {
  // Measured live: searching "Lynden" returns com.lynden.compassapp alongside a yoga collective and
  // several unrelated apps. Taking the first result is how a freight company acquires a yoga app.
  const p = pickAndroidPackage("Lynden",
    page("com.fitnessmobileapps.lyndenyogacollective43122", "com.lynden.compassapp", "cn.noerdenfit.life"),
    ["Compass"]);
  assert.equal(p?.id, "com.lynden.compassapp");
  assert.equal(p?.basis, "package names the company");
});

test("the id and a link to it are recorded, so a later pass can check this one", () => {
  // The whole point: the row must address a page somebody can fetch and disagree with.
  const p = pickAndroidPackage("Chrobinson", page("com.chrobinson.navispherecarrier"), ["Navisphere Carrier"]);
  assert.equal(p?.id, "com.chrobinson.navispherecarrier");
  assert.equal(p?.url, "https://play.google.com/store/apps/details?id=com.chrobinson.navispherecarrier");
});

test("a weaker basis is recorded AS weaker, never silently as the same thing", () => {
  // No package names the company, so this rests on nothing but search-result order. That is what the
  // old code was already doing — the change is that it now says so instead of storing a bare "1".
  const p = pickAndroidPackage("Interport", page("com.example.somethingelse", "io.other.app"), []);
  assert.equal(p?.id, "com.example.somethingelse");
  assert.equal(p?.basis, "first result on the search page");
  assert.notEqual(p?.basis, "package names the company", "the two must stay distinguishable in the row");
});

test("a page with no app links yields nothing rather than a guess", () => {
  assert.equal(pickAndroidPackage("Lynden", "<html>no results</html>", ["Lynden"]), null);
});

test("a short company name cannot claim a package — the same floor the label match uses", () => {
  // "us" or "ey" would otherwise match a segment of almost any package id, which is the exact
  // non-distinctive-stem failure that put ten unrelated employers under one domain.
  const p = pickAndroidPackage("US", page("com.us.somethingunrelated", "com.other.app"), []);
  assert.equal(p?.basis, "first result on the search page", "two characters must not corroborate anything");
});
