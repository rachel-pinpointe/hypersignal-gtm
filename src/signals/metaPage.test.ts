// Tests for advertiser-page resolution — the identity check that replaced keyword guessing.
//
// The old ad producer searched the Ad Library for the company's NAME and reported the hit count as
// that company's ad volume. Measured on the live database that flagged 49% of every watched domain
// as an active advertiser and pinned 43 of them at Meta's 50,000-result ceiling. The approach here
// is ported from the meta-ads-scraper project in this workspace: read the brand's own Facebook or
// Instagram handle off its own website, match it EXACTLY against the handle Meta reports for each
// advertiser page, and refuse to answer when nothing matches.
//
// Everything below is the pure half of that chain. The network halves (site fetch, typeahead
// replay) are not testable without a browser; these are the parts that decide identity, and a
// wrong decision here files another company's ad spend under this one.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHandlesFromHtml, normHandle, pickHandleMatch, type AdvertiserPage } from "./metaPage.ts";

const page = (o: Partial<AdvertiserPage> & { pageId: string }): AdvertiserPage =>
  ({ name: "Some Page", ...o });

// ---------------------------------------------------------------------------------------------
// Handle extraction
// ---------------------------------------------------------------------------------------------

test("a footer's own profile links are the handles", () => {
  const h = extractHandlesFromHtml(`
    <footer>
      <a href="https://www.facebook.com/acmelogistics">FB</a>
      <a href="https://www.instagram.com/acme.logistics/">IG</a>
    </footer>`);
  assert.equal(h.facebook, "acmelogistics");
  assert.equal(h.instagram, "acme.logistics");
});

test("share buttons and tracking pixels are not the brand's profile", () => {
  // THE load-bearing case. A share widget appears before the footer on most sites, so without the
  // reject list the winner is "sharer.php" — and then every site on the internet resolves to the
  // same handle and matches the same advertiser page.
  const h = extractHandlesFromHtml(`
    <a href="https://www.facebook.com/sharer/sharer.php?u=https://acme.com">Share</a>
    <img src="https://www.facebook.com/tr?id=123&ev=PageView">
    <a href="https://www.facebook.com/plugins/like.php">Like</a>
    <a href="https://www.facebook.com/realacme">Our page</a>`);
  assert.equal(h.facebook, "realacme");
});

test("Instagram post and reel links are not the brand's profile", () => {
  const h = extractHandlesFromHtml(`
    <a href="https://www.instagram.com/p/Cabc123/">A post</a>
    <a href="https://www.instagram.com/reel/Cxyz/">A reel</a>
    <a href="https://www.instagram.com/acmebrand">Follow us</a>`);
  assert.equal(h.instagram, "acmebrand");
});

test("a numeric profile.php link yields the page id itself", () => {
  // The most useful shape there is: it IS a Meta page id, comparable without any name matching.
  const h = extractHandlesFromHtml(`<a href="https://www.facebook.com/profile.php?id=100064123456789">FB</a>`);
  assert.equal(h.facebook, "100064123456789");
});

test("bare platform links carry no identity", () => {
  const h = extractHandlesFromHtml(`
    <a href="https://facebook.com/">Facebook</a>
    <a href="https://www.instagram.com/explore/tags/logistics/">Tag</a>`);
  assert.equal(h.facebook, undefined);
  assert.equal(h.instagram, undefined);
});

test("m., web. and fb.com hosts are the same platform", () => {
  assert.equal(extractHandlesFromHtml(`<a href="https://m.facebook.com/acmeco">x</a>`).facebook, "acmeco");
  assert.equal(extractHandlesFromHtml(`<a href="https://fb.com/acmeco">x</a>`).facebook, "acmeco");
});

test("a page with no social links yields nothing rather than a guess", () => {
  assert.deepEqual(extractHandlesFromHtml("<html><body><h1>Acme</h1></body></html>"), {});
});

// ---------------------------------------------------------------------------------------------
// Normalization + the identity match
// ---------------------------------------------------------------------------------------------

test("handles compare case- and punctuation-insensitively at the edges only", () => {
  assert.equal(normHandle("@AcmeCo/"), "acmeco");
  assert.equal(normHandle("  ACME.co  "), "acme.co");
  assert.equal(normHandle(undefined), "");
  assert.equal(normHandle(null), "");
  // A dot inside the handle is significant — acme.co and acmeco are different accounts.
  assert.notEqual(normHandle("acme.co"), normHandle("acmeco"));
});

test("an exact Facebook handle match identifies the page", () => {
  const pages = [page({ pageId: "111", name: "Acme Freight", pageAlias: "acmefreight" }),
                 page({ pageId: "222", name: "Acme Bakery", pageAlias: "acmebakery" })];
  const hit = pickHandleMatch(pages, { facebook: "acmefreight" });
  assert.equal(hit?.page.pageId, "111");
  assert.equal(hit?.via, "fb");
});

test("Facebook wins over Instagram when both would match", () => {
  // page_alias is what the Ad Library itself keys on, so it is the stronger of the two.
  const pages = [page({ pageId: "111", pageAlias: "acme", igUsername: "other" }),
                 page({ pageId: "222", igUsername: "acmegram" })];
  assert.equal(pickHandleMatch(pages, { facebook: "acme", instagram: "acmegram" })?.page.pageId, "111");
});

test("Instagram carries the match when the site links no Facebook page", () => {
  const pages = [page({ pageId: "333", igUsername: "AcmeGram" })];
  const hit = pickHandleMatch(pages, { instagram: "@acmegram" });
  assert.equal(hit?.page.pageId, "333");
  assert.equal(hit?.via, "ig");
});

test("a numeric handle from profile.php matches the page id directly", () => {
  const pages = [page({ pageId: "100064123456789", name: "Acme" })];
  assert.equal(pickHandleMatch(pages, { facebook: "100064123456789" })?.page.pageId, "100064123456789");
});

test("a near miss is NOT a match — this is the whole point of the module", () => {
  // Every one of these would have passed under name matching, and every one is a different company.
  const pages = [
    page({ pageId: "1", name: "Acme Freight Ltd", pageAlias: "acmefreightltd" }),
    page({ pageId: "2", name: "Acme", pageAlias: "acme" }),
    page({ pageId: "3", name: "Acme Freight Official", pageAlias: "acme.freight" }),
  ];
  assert.equal(pickHandleMatch(pages, { facebook: "acmefreight" }), null);
});

test("an Instagram handle is never matched against a page's Facebook alias", () => {
  // The two namespaces are unrelated: @acmefreight on Instagram and facebook.com/acmefreight can be
  // different companies entirely, and Meta hands both fields back on the same object. The fixture
  // has to make the alias EQUAL the IG handle, or a lenient implementation is never exercised.
  // Two shapes, because they fail differently: a page that reports BOTH fields, and — the common
  // one, since Meta frequently omits ig_username — a page that reports only the Facebook alias.
  const pages = [
    page({ pageId: "9", name: "Someone Else", pageAlias: "acmefreight", igUsername: "someoneelse" }),
    page({ pageId: "8", name: "Also Not Them", pageAlias: "acmefreight" }),
  ];
  assert.equal(pickHandleMatch(pages, { instagram: "acmefreight" }), null);
  // ...while a page whose IG handle genuinely matches still resolves.
  assert.equal(pickHandleMatch([...pages, page({ pageId: "10", igUsername: "acmefreight" })],
    { instagram: "acmefreight" })?.page.pageId, "10");
});

test("no handles on the site means no match, never a first-result fallback", () => {
  const pages = [page({ pageId: "1", name: "Acme Freight", pageAlias: "acmefreight" })];
  assert.equal(pickHandleMatch(pages, {}), null);
  assert.equal(pickHandleMatch(pages, { facebook: "", instagram: "  " }), null);
});

test("a page Meta returns without any handle can never be matched", () => {
  // Meta omits page_alias for plenty of pages. Such a page must simply never match, rather than
  // matching whatever the site happened to publish.
  assert.equal(pickHandleMatch([page({ pageId: "1", name: "Acme" })], { facebook: "acme" }), null);
  assert.equal(pickHandleMatch([page({ pageId: "1", name: "Acme", pageAlias: "" })], { facebook: "acme" }), null);
  // Both sides blank is the dangerous shape — it must not resolve to "" === "" and match everything.
  // (The empty site handle is rejected before the comparison, so this can only fail if that changes.)
  assert.equal(pickHandleMatch([page({ pageId: "1", name: "Acme", pageAlias: "" })], { facebook: "" }), null);
});

test("an empty suggestion list is not an error", () => {
  assert.equal(pickHandleMatch([], { facebook: "acme" }), null);
});
