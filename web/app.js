const $ = (id) => document.getElementById(id);
// Inline SVG icon set (no emojis anywhere). Lucide-style, currentColor, sized via .ic.
const SVG = (p) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  pin: SVG('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/>'),
  target: SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>'),
  upload: SVG('<path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/>'),
  download: SVG('<path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"/><path d="M7 11l5 5 5-5"/><path d="M12 16V4"/>'),
  stop: SVG('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: SVG('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  repeat: SVG('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  spark: SVG('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
  external: SVG('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  chevron: SVG('<path d="m6 9 6 6 6-6"/>'),
  file: SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  clock: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: SVG('<path d="M20 6 9 17l-5-5"/>'),
  star: SVG('<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21.5l1.2-6.5L2.5 9.4l6.6-.9z"/>'),
  starFill: SVG('<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21.5l1.2-6.5L2.5 9.4l6.6-.9z" fill="currentColor"/>'),
  hide: SVG('<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6"/><path d="M3 3l18 18"/>'),
};
// aria-hidden + focusable=false at the ONE place icons are produced: all 162 are decorative
// path-only glyphs whose parent button already carries the accessible name.
const icon = (n) => (ICONS[n] || "").replace("<svg ", "<svg aria-hidden=\"true\" focusable=\"false\" ");
const state = { offset: 0, limit: 15, total: 0, client: localStorage.getItem("se_client") || "", sources: [], remoteSel: [],
  kind: "search", view: "clients", seniSel: [], techSel: [], signalSel: [], postTab: "postings", starredOnly: false,
  // advanced-filter trees per scope ("m:search" | "m:watchlist" | "admin" | "checking"), persisted
  adv: (() => { try { return JSON.parse(localStorage.getItem("se_adv") || "{}"); } catch { return {}; } })() };
const saveAdv = () => localStorage.setItem("se_adv", JSON.stringify(state.adv));
// Per-tab kind: Client Monitoring = "search", Account Monitoring = "watchlist".
// Both monitor entry points now resolve to the merged "Monitors" view (kind "all" = searches +
// watchlists together). "accounts" is kept as an alias so old deep links / bookmarks still resolve.
const KIND_OF_VIEW = { clients: "all", accounts: "all" };
// Active-tab noun + scope query param for maintenance actions (hide / restore / verify), so they
// always act on exactly what the table shows: a specific client, else the active monitoring kind
// (never silently spanning both Client and Account monitoring).
const kindNoun = (n) => state.kind === "all" ? (n === 1 ? "tracker" : "trackers")
  : state.kind === "watchlist" ? (n === 1 ? "watchlist" : "watchlists")
  : (n === 1 ? "search" : "searches");
const scopeParam = () => state.client ? "?client=" + encodeURIComponent(state.client) : "?kind=" + state.kind;

const esc = (s) => (s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

// The create endpoints already return {submitted, capped, cap} when a list was truncated at
// ACCOUNT_MAX — and nothing in the whole of web/ ever read those three fields, so a run that silently
// dropped 1,001 of 10,001 domains toasted the truncated count as if it were the whole list and the
// detail chip then read "10,000 domains submitted" forever. Account Check warned pre-run using its own
// hardcoded copy of the number (which diverges the moment ACCOUNT_MAX is set); Signal Check and the
// bulk path said nothing at all. One helper, driven by what the server actually reports.
function capNote(d) {
  if (!d || !d.capped) return "";
  const dropped = Number(d.submitted || 0) - Number(d.count || 0);
  return `Only the first ${fmtNum(d.cap)} of ${fmtNum(d.submitted)} were queued — ${fmtNum(dropped)} were not checked.`;
}

// Several source fields arrive as a JSON ARRAY STRING rather than a value — industry is one on ~97%
// of jobs ('["Accounting","Management Consulting"]'). Render them the way the app renders every other
// multi-value field, with the " · " separator it already uses. Anything that is not a JSON array is
// returned untouched, so a plain string stays a plain string.
function listish(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(" · ");
  const s = String(v ?? "");
  if (s[0] !== "[") return s;
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.filter(Boolean).join(" · ") : s; } catch { return s; }
}

// esc() stops an attribute break-out but NOT a dangerous scheme — "javascript:…" survives it intact.
// Every URL rendered as an href comes from a third party (apply_url, scraped hrefs, ATS tenant slugs,
// the admin job editor), and this dashboard can reach the whole local API, so a clickable
// javascript: link would be a one-click own-goal. Anything that is not plain http(s) renders inert.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "").trim()) ? esc(u) : "");

// ── Clickable rows ───────────────────────────────────────────────────────────────────────────────
// One place for "this whole row opens the thing". It does two jobs that were previously missing or
// done badly:
//  1. Clicks that START inside an inner control (a link, a button, a checkbox) belong to that
//     control, not the row. This used to be 15 inline attributes
//     scattered through the templates — which a strict Content-Security-Policy forbids outright.
//  2. Keyboard users can activate the row. A <tr> is not focusable and has no default activation,
//     so row details were mouse-only; tabindex + Enter/Space fixes that. No role is set: a row is
//     still a row, and role="button" would strip it out of the table for a screen reader.
const INNER_CONTROL = "a,button,input,select,textarea,label,[data-stop]";
/** Make a whole row activatable by mouse AND keyboard.
 *
 *  role + a name matter as much as the tabIndex: a <tr> with a tabindex and an Enter handler is
 *  announced as a plain table row, so nothing tells assistive tech it does anything. The name is
 *  taken from the row's first cell (the company/domain/title), which is what a user would call it. */
function rowActivate(el, fn) {
  el.tabIndex = 0;
  if (!el.hasAttribute("role")) el.setAttribute("role", "button");
  if (!el.hasAttribute("aria-label")) {
    const name = (el.querySelector("td, .ac-row-name")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (name) el.setAttribute("aria-label", name + " — open details");
  }
  el.onclick = (e) => { if (e.target.closest(INNER_CONTROL)) return; fn(e); };
  el.onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== el) return;            // a focused inner control handles its own keys
    e.preventDefault();                     // Space must not scroll the page
    fn(e);
  };
}

// ── Tooltip portal: ONE fixed-position on-design bubble reused for every [data-tip] element ──────
// Replaces every native title= (OS tooltip) and the old CSS-only ::after bubble. Delegated, so rows
// re-rendered via innerHTML need no re-wiring. Hover shows after 250ms; keyboard focus is immediate.
const tipPortal = (() => {
  const el = document.createElement("div");
  el.id = "tipPortal"; el.setAttribute("role", "tooltip"); el.hidden = true;
  document.body.appendChild(el);
  return el;
})();
let tipTarget = null, tipTimer = null;
function positionTip(target) {
  const r = target.getBoundingClientRect();
  tipPortal.style.visibility = "hidden"; tipPortal.hidden = false;
  const w = tipPortal.offsetWidth, h = tipPortal.offsetHeight;
  const cx = r.left + r.width / 2;
  let top = r.top - h - 9;
  const below = top < 6;
  if (below) top = r.bottom + 9;
  tipPortal.classList.toggle("below", below);
  const left = Math.max(8, Math.min(cx - w / 2, window.innerWidth - w - 8));
  tipPortal.style.left = left + "px"; tipPortal.style.top = top + "px";
  tipPortal.style.setProperty("--arrow-x", Math.max(12, Math.min(cx - left, w - 12)) + "px");
  tipPortal.style.visibility = "";
}
function showTip(target) {
  const text = target.getAttribute("data-tip"); if (!text) return;
  tipTarget = target;
  tipPortal.textContent = text;
  positionTip(target);
  tipPortal.classList.add("on");
  target.setAttribute("aria-describedby", "tipPortal");
}
function hideTip() {
  clearTimeout(tipTimer); tipTimer = null;
  if (tipTarget) tipTarget.removeAttribute("aria-describedby");
  tipTarget = null;
  tipPortal.classList.remove("on"); tipPortal.hidden = true;
}
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t || t === tipTarget) return;
  hideTip();
  tipTimer = setTimeout(() => showTip(t), 250);
});
document.addEventListener("mouseout", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) hideTip();
});
document.addEventListener("focusin", (e) => { const t = e.target.closest?.("[data-tip]"); if (t) { hideTip(); showTip(t); } });
document.addEventListener("focusout", hideTip);
document.addEventListener("scroll", hideTip, true);   // any scroll container (capture)
window.addEventListener("resize", hideTip);
document.addEventListener("click", hideTip, true);    // also covers the target being re-rendered away
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
const fmtNum = (n) => Number(n).toLocaleString();
// Two timestamp shapes reach this: SQLite's "2026-07-25 12:00:00" (UTC, no zone marker) and a
// producer's real ISO-8601 ("2026-07-25T12:00:00Z" / "+02:00"). Appending "Z" unconditionally
// turned the second kind into "...ZZ" or "...+02:00Z", which Date rejects — the signal drawer
// printed the literal text "Invalid Date" for the event date. Only stamp UTC on the naive form.
const fmtTime = (s) => {
  if (!s) return "—";
  const raw = String(s);
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw.replace(" ", "T") : raw.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? raw : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
// Plain text only. The styled version is fmtAgoHtml — keeping the two apart matters because a
// call site that (correctly) escapes its input printed the literal "<span style=…>2d ago</span>"
// on screen. A function whose NAME does not say "Html" must be safe to escape.
function fmtAgo(s) {
  if (!s) return "";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (isNaN(mins) || mins < 0) return "";
  return mins < 60 ? (mins <= 1 ? "just now" : mins + "m ago")
    : mins < 1440 ? Math.floor(mins / 60) + "h ago"
    : mins < 43200 ? Math.floor(mins / 1440) + "d ago"
    : Math.floor(mins / 43200) + "mo ago";
}
// Same value, wrapped for display: green while it is still fresh (< 48h), muted after.
function fmtAgoHtml(s) {
  const txt = fmtAgo(s);
  if (!txt) return `<span class="ago none">—</span>`;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const fresh = (Date.now() - new Date(iso).getTime()) / 60000 < 2880;
  return `<span class="ago${fresh ? " fresh" : ""}">${txt}</span>`;
}

let CONFIGS = [];

// Saved Account Checks (id + name) — drives "Matched by" attribution for one-off checks. A check's
// value is "ac:<id>" (ids are stable; names can repeat), shown as "[Check] <name>".
let AC_MONITORS = [];
async function loadConfig() {
  // The primary fetch had no error branch, so a single failed /api/config threw out of every
  // caller — an unhandled rejection, a blank Signals view, and the global handler's error toast
  // repeating every 60 seconds with no way to recover but a reload. Keep the last known configs
  // (better than none), tell the user once, and let the next poll heal it.
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("the server replied " + res.status);
    CONFIGS = await res.json();
  } catch (e) {
    console.warn("[config]", e);
    if (!CONFIGS.length) toast("Couldn't load your monitors — retrying. Check that the engine is running.", true);
    return;
  }
  // Do NOT blank the list on failure: these are the "Matched by" filter's options, and an empty
  // dropdown says "you have no account checks" — a statement about the user's data, made because a
  // request timed out. Keep what we last knew and retry; on a first-load failure it stays empty
  // (nothing else is true yet) but self-heals instead of staying wrong until a reload.
  try {
    const acs = await fjson("/api/account/searches");
    AC_MONITORS = (Array.isArray(acs) ? acs : (acs.items || [])).map(a => ({ id: "ac:" + a.id, name: a.name || "(unnamed check)" }));
  } catch { retrySoon("acMonitors", loadConfig); }
  // The picker lists the trackers in scope. In the merged "Monitors" view (kind "all") that is every
  // tracker — searches AND watchlists — each tagged by type so the one list stays legible.
  const all = state.kind === "all";
  const mine = all ? CONFIGS.slice() : CONFIGS.filter(c => (c.kind || "search") === state.kind);
  if (state.client && !mine.some(c => c.name === state.client)) state.client = ""; // selected item isn't in scope
  const allLabel = all ? "All trackers" : state.kind === "watchlist" ? "All watchlists" : "All searches";
  const allCount = mine.reduce((a, c) => a + c.matches, 0);
  const tag = (c) => all ? ((c.kind === "watchlist" ? "[Account] " : "[Keyword] ")) : "";
  // One dropdown for the picker (was a horizontal tab strip that grew unbounded with clients).
  const sel = $("clientSelect");
  sel.innerHTML = [`<option value="">${esc(allLabel)} (${fmtNum(allCount)})</option>`]
    .concat(mine.map(c => `<option value="${esc(c.name)}">${esc(tag(c) + c.name)} (${fmtNum(c.matches)})</option>`)).join("");
  sel.value = state.client;
  sel.onchange = () => selectClient(sel.value);
  renderSetup();
  // Jobs database "Matched by" dropdown — every monitor AND every saved Account Check, labelled by
  // feature (isolate any run's rows, incl. what a specific check inserted).
  const mon = $("admMonitor");
  if (mon) {
    const cur = mon.value;
    mon.innerHTML = '<option value="">Matched by: any monitor</option>'
      + CONFIGS.map(c => `<option value="${esc(c.name)}">${(c.kind === "watchlist" ? "[Account] " : "[Client] ") + esc(c.name)}</option>`).join("")
      + AC_MONITORS.map(a => `<option value="${esc(a.id)}">[Check] ${esc(a.name)}</option>`).join("");
    mon.value = cur;
  }
}
// Label for a monitor value anywhere it's displayed ("ac:<id>" → the check's name).
function monitorLabel(v) {
  if (v.startsWith("ac:")) { const a = AC_MONITORS.find(x => x.id === v); return "[Check] " + (a ? a.name : v.slice(3)); }
  const c = CONFIGS.find(x => x.name === v);
  return (c?.kind === "watchlist" ? "[Account] " : "[Client] ") + v;
}

function renderSetup() {
  // Fetch + Edit act on ONE selected search/watchlist — hide them entirely on the combined "All" tab
  // (where there's no single target). "+ New" stays available.
  const single = !!state.client;
  $("editBtn").style.display = single ? "" : "none";
  $("fetchBtn").style.display = single ? "" : "none";
  $("editBtn").disabled = !single;
  $("fetchBtn").disabled = !single;
  if (single) refreshFetchStatus();
  const c = CONFIGS.find(x => x.name === state.client);
  const mineCount = state.kind === "all" ? CONFIGS.length : CONFIGS.filter(x => (x.kind || "search") === state.kind).length;
  if (!c) {
    const noun = kindNoun(mineCount);
    $("setup").innerHTML = `<span><b>${mineCount}</b> ${noun} configured · combined view</span>`;
    return;
  }
  const dpd = c.datePostedDays ? `≤${c.datePostedDays}d` : "any time";
  if ((c.kind || "search") === "watchlist") { // watchlists are domain-first; show what's relevant locally
    $("setup").innerHTML = `
      <span>${icon('target')} <b>${c.orgDomains}</b> domain${c.orgDomains === 1 ? "" : "s"} watched</span>
      <span><b>${c.keywords}</b> role keyword${c.keywords === 1 ? "" : "s"}</span>
      <span>${icon('pin')} <b>${esc(c.location || "anywhere")}</b>${c.locationCount > 1 ? ` +${c.locationCount - 1}` : ""}</span>
      <span>posted: <b>${dpd}</b></span>
      <span class="wh ${c.hasWebhook ? "on" : "off"}"><span class="d"></span>${c.hasWebhook ? "webhook set" : "dashboard only"}</span>`;
    return;
  }
  const wp = (c.workplaceTypes || []).length ? c.workplaceTypes.join(", ") : "any workplace";
  const sl = (c.seniorityLevels || []).length ? c.seniorityLevels.join(", ") : "";
  $("setup").innerHTML = `
    <span><b>${c.keywords}</b> keyword${c.keywords === 1 ? "" : "s"}</span>
    <span><b>${c.sourceMode === "corporate_local" ? "Companies + Local" : "Companies"}</b></span>
    ${sl ? `<span><b>${esc(sl)}</b></span>` : ""}
    <span>${icon('pin')} <b>${esc(c.location || "anywhere")}</b>${c.locationCount > 1 ? ` +${c.locationCount - 1}` : ""}</span>
    <span>${esc(wp)}</span>
    <span>posted: <b>${dpd}</b></span>
    <span class="wh ${c.hasWebhook ? "on" : "off"}"><span class="d"></span>${c.hasWebhook ? "webhook set" : "dashboard only"}</span>`;
}

function selectClient(name) {
  state.client = name; state.offset = 0;
  localStorage.setItem("se_client", name);
  const sel = $("clientSelect"); if (sel && sel.value !== name) sel.value = name; // keep the dropdown in sync
  $("tablePanel").classList.toggle("hide-client", name !== ""); // show Client column only in All view
  renderSetup(); loadStats();
  if (state.postTab === "companies") { coState.offset = 0; loadCompanies(); } else loadMatches();
  renderProminentFetch(); renderFetchDock(); // re-scope the in-view bar + the "elsewhere" dock to this tab
}

// ---- Sidebar feature switch: Client Monitoring (search) / Account Monitoring (watchlist) / Account Checking ----
function applyKindChrome() {
  const wl = state.kind === "watchlist", all = state.kind === "all";
  $("monitorTitle").textContent = all ? "Monitors" : wl ? "Account Monitoring" : "Client Monitoring";
  $("monitorSub").textContent = all
    ? "Every tracker you're running — keyword searches and watched account lists — in one place."
    : wl ? "Account-first: watch specific company domains for the roles you care about."
    : "Keyword-first: find everyone hiring for your roles, anywhere.";
  $("newBtn").textContent = all ? "+ New tracker" : wl ? "+ New watchlist" : "+ New search";
  $("companiesTitle").textContent = wl ? "Top accounts hiring" : "Top hiring companies";
  $("tablePanel").classList.toggle("hide-client", state.client !== "");
}
// ── URL state ────────────────────────────────────────────────────────────────────────────────────
// The whole app lived at "/" with no history entries at all: pressing Back left the app entirely,
// refresh dropped you on the default view, and no screen could be bookmarked or sent to a colleague.
// A hash carries the view and the Signals sub-tab; popstate restores them. hashApplying guards the
// write-read loop, since assigning location.hash fires hashchange.
let hashApplying = false;
function syncHash() {
  if (hashApplying) return;
  const want = "#/" + state.view + (state.view === "signals" && sigTab !== "feed" ? "/" + sigTab : "");
  if (location.hash === want) return;
  history.pushState(null, "", want);
}
// The set of real views, read from the sidebar so it can never drift from the markup.
const knownView = (v) => !!v && !!document.querySelector(`.side-item[data-view="${CSS.escape(v)}"]`);
/** @param force - at boot, render even when the hash names the view state already claims to be on
 *  (state.view starts at "clients", so "#/clients" would otherwise no-op into a blank shell). */
function applyHash(force = false) {
  const [, view, sub] = (location.hash || "").replace(/^#\/?/, "/").split("/");
  if (!view) return;
  // A stale bookmark or a typo used to hide every section and leave an empty page with no way back.
  if (!knownView(view)) { if (force) showView(localStorage.getItem("se_view") || "home"); return; }
  hashApplying = true;
  try {
    if (force || view !== state.view) showView(view);
    // No sub-segment means the DEFAULT sub-tab, not "leave whatever is showing" — otherwise going
    // Feed → Checks and pressing Back restored the URL but left Checks on screen.
    if (view === "signals") { const want = sub || "feed"; if (want !== sigTab) sigShowTab(want); }
  } finally { hashApplying = false; }
}
window.addEventListener("popstate", applyHash);

function showView(view) {
  const changing = state.view !== view;
  // Leaving Signals/Checking must tear down any open detail SSE stream — otherwise a running
  // signal-check / account-check keeps an EventSource consuming after the view is hidden.
  if (changing) { scCloseStream(); acCloseStream(); if (typeof bulkExit === "function") bulkExit(); }
  state.view = view;
  localStorage.setItem("se_view", view); // persist the active tab across reload/restart
  syncHash();                            // and put it in the URL so Back/refresh/bookmark all work
  // Move focus into the new view so the change is ANNOUNCED and the next Tab starts from the
  // content, not the top of the 12-item sidebar. Only on a real change, and only when focus was
  // not already deliberately placed inside something (a drawer, a field).
  if (changing) requestAnimationFrame(() => {
    const main = $("mainContent");
    if (!main) return;
    // The VISIBLE heading, scoped to the ACTIVE view. Two traps here, both hit in turn:
    //   1. querySelector returns the first match in DOCUMENT order, which is always the Home view's
    //      <h2> — display:none on 7 of the 8 views — so focusing it did nothing anywhere but Home.
    //   2. Filtering by offsetParent fixed Home and the two monitor views and nothing else: #drawer
    //      is a SIBLING of the views (index.html:273), and when closed it is position:fixed +
    //      visibility:hidden, which leaves offsetParent NON-null. So on the six views that follow it
    //      in document order the "visible heading" resolved to the closed client editor's
    //      <h2>Edit client</h2> — inert, invisible, 75x24 — and focus stayed on <body>.
    // Scoping to the one .view that is not [hidden] excludes the drawer structurally; checkVisibility
    // then also excludes a heading inside a collapsed sub-tab, which offsetParent alone would not.
    const view = main.querySelector(".view:not([hidden])") || main;
    const shown = (n) => (n.checkVisibility ? n.checkVisibility({ visibilityProperty: true }) : n.offsetParent !== null);
    // Leave focus alone only if it is somewhere STILL VISIBLE inside main — an open drawer, a field
    // the user is typing in. The old guard was a bare main.contains(), which also matched the heading
    // of the view being LEFT: that node is inside main but about to be display:none, so the guard
    // skipped, the browser then blurred it, and focus fell to <body>. Same visibility test as above.
    const a = document.activeElement;
    if (a && a !== document.body && main.contains(a) && shown(a)) return;
    const h = [...view.querySelectorAll("h1, h2")].find(shown);
    const target = h || view;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  });
  document.querySelectorAll(".side-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("viewMonitor").hidden = (view !== "clients" && view !== "accounts");
  $("viewChecking").hidden = (view !== "checking");
  $("viewAdmin").hidden = (view !== "admin");
  $("viewSystem").hidden = (view !== "system");
  $("viewTechnologies").hidden = (view !== "technologies");
  $("viewSignals").hidden = (view !== "signals");
  $("viewGuide").hidden = (view !== "guide");
  $("viewHome").hidden = (view !== "home");
  // The next-auto-fetch countdown belongs to the monitor views; leaving them used to leave its 1s
  // interval running against an element nobody can see.
  if (view !== "clients" && view !== "accounts") paintNextFetch(null);
  if (view === "home") { renderProminentFetch(); renderFetchDock(); ensureMeta(); loadHome(); return; }
  if (view === "guide") { renderGuide(); return; }
  if (view === "checking") { renderProminentFetch(); renderFetchDock(); ensureMeta(); acCloseStream(); acShow("list"); acLoadList(); return; }
  if (view === "admin") { renderProminentFetch(); renderFetchDock(); ensureMeta(); loadAdmin(); return; }
  if (view === "system") { renderProminentFetch(); renderFetchDock(); loadSystem(); return; }
  if (view === "technologies") { renderProminentFetch(); renderFetchDock(); loadTechnologiesView(); return; }
  if (view === "signals") { renderProminentFetch(); renderFetchDock(); ensureMeta(); loadSignalsView(); return; }
  const newKind = KIND_OF_VIEW[view] || "search";
  if (changing && newKind !== state.kind) { state.client = ""; state.offset = 0; } // start on the kind's "All" view
  state.kind = newKind;
  applyKindChrome();
  state.postTab = "postings"; postTabHtml("postings"); // each monitor view opens on Postings
  loadConfig(); loadStats(); loadMatches();
  renderProminentFetch(); renderFetchDock(); // re-scope the in-view bar + "elsewhere" dock to the new view/kind
}

// Booting straight into Jobs database / Account Checking (persisted tab) skips the monitor views'
// loadConfig()/loadStats(), leaving CONFIGS (the "Matched by" dropdown + the builder's monitor
// options) and qbStateOpts (the builder's State options) empty until a monitor tab is visited.
// Backfill them on entry — and refresh the advanced-filter badges, which only loadStats did before.
async function ensureMeta() {
  if (!CONFIGS.length) await loadConfig();
  if (!qbStateOpts.length) {
    try {
      const s = await fjson("/api/stats?kind=" + state.kind);
      qbStateOpts = (s.byState || []).map(r => r.state).filter(Boolean);
      qbCountryOpts = (s.byCountry || []).map(r => r.country).filter(Boolean);
      qbCurrencyOpts = (s.byCurrency || []).map(r => r.currency).filter(Boolean);
    // Retry: these three lists are the builder's State, Country and Salary-currency options, and one
    // failed request left all three empty for the session — a filter that cannot be built looks like a
    // filter the app does not support.
    } catch { retrySoon("qbOpts", ensureMeta); }
  }
  refreshAdvBadges();
}

async function loadStats() {
  const p = state.client ? "?client=" + encodeURIComponent(state.client) : "?kind=" + state.kind;
  const tok = loadToken("stats");   // switching client/kind twice quickly must not restore the first scope
  let s;
  try { s = await fjson("/api/stats" + p); }
  catch { retrySoon("stats", loadStats); return; } // stats keep their last values; retry quietly
  if (loadStale("stats", tok)) return;
  $("stats").innerHTML = [
    ["Jobs found", fmtNum(s.totalFound)],
    [state.client ? "Matches (this client)" : "Total matches", fmtNum(s.totalMatches)],
    ["Open now", fmtNum(s.statusCounts?.open ?? 0)],
    ["Companies hiring", fmtNum(s.companiesHiring ?? s.topCompanies.length)],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

  const stSel = $("state"), cur = stSel.value;
  stSel.innerHTML = '<option value="">All states</option>' + s.byState.map(r => `<option value="${esc(r.state)}">${esc(r.state)} (${r.c})</option>`).join("");
  stSel.value = cur;
  qbStateOpts = (s.byState || []).map(r => r.state).filter(Boolean);       // feed the builder's State field
  qbCountryOpts = (s.byCountry || []).map(r => r.country).filter(Boolean); // …and its Country field
  qbCurrencyOpts = (s.byCurrency || []).map(r => r.currency).filter(Boolean); // …and its Currency field
  refreshAdvBadges();

  $("companies").innerHTML = s.topCompanies.length
    ? s.topCompanies.map(c => {
        const cl = c.clients ? String(c.clients).split(",") : [];
        // In the combined ("All") view, tag which search(es) flagged the company (deduped across them).
        const tag = (!state.client && cl.length) ? ` · ${esc(cl[0])}${cl.length > 1 ? ` +${cl.length - 1}` : ''}` : '';
        return `<div class="vrow"><span class="co">${esc(c.company)}${c.has_repeat ? `<span class="badge" data-tip="re-posted role">${icon('repeat')} repeat</span>` : ''}</span><span class="n">${c.open_roles} roles${tag}</span></div>`;
      }).join("")
    : '<div class="vempty">No company has ≥2 matched roles in this view yet.</div>';
}

function filterParams() {
  const p = new URLSearchParams();
  if (state.client) p.set("client", state.client);
  else if (state.kind !== "all") p.set("kind", state.kind); // scope the "All" view to the tab's kind; "all" = every tracker
  if ($("state").value) p.set("state", $("state").value);
  if ($("status").value) p.set("status", $("status").value);
  if ($("q").value) { p.set("q", $("q").value); if ($("qFuzzy").checked) p.set("fuzzy", "1"); }
  if ($("since").value) p.set("postedWithinDays", $("since").value);
  if (state.remoteSel.length === 1) p.set("remote", state.remoteSel[0] === "remote" ? "1" : "0"); // both/none = any
  if (state.seniSel.length) p.set("seniority", state.seniSel.join(","));
  if (state.techSel.length) p.set("tech", state.techSel.join(","));
  if (state.signalSel.length) p.set("signals", state.signalSel.join(","));
  if (state.starredOnly) p.set("starred", "1");
  if (state.msort) { p.set("sort", state.msort); p.set("dir", state.mdir || "desc"); }
  const tree = state.adv["m:" + state.kind];
  if (advHasConds(tree)) p.set("adv", JSON.stringify(tree));
  return p;
}
// Wire sortable table headers: click cycles sort key / flips direction, marks the active header.
function wireSortHeaders(theadSel, attr, getSort, getDir, onSort) {
  document.querySelectorAll(`${theadSel} [${attr}]`).forEach(th => {
    const key = th.getAttribute(attr);
    th.classList.toggle("sorted", key === getSort());
    th.setAttribute("aria-sort", key === getSort() ? (getDir() === "asc" ? "ascending" : "descending") : "none");
    const flip = () => {
      if (getSort() === key) onSort(key, getDir() === "asc" ? "desc" : "asc");
      // Text columns open A→Z, everything else opens biggest/newest-first. ("domain" is the signal-
      // check grid's first column; without it the first click sorted Z→A, which reads as broken.)
      else onSort(key, ["company", "title", "location", "name", "category", "domain"].includes(key) ? "asc" : "desc");
    };
    th.onclick = flip;
    // A bare <th> is not focusable and has no default activation, so every sortable column in the
    // app was mouse-only — on a large result set that removes the only way to reorder the data.
    th.tabIndex = 0;
    th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
  });
}

let matchRowsById = {}; // current page's rows, for the detail drawer (rows already carry every facet)
// Animated skeleton rows for a table body while it loads/refetches — varying bar widths per column so
// it reads as content settling in, not a progress bar. Shown on foreground loads (view/filter/sort/
// page/save), never the silent 60s poll (which doesn't call these).
const SK_W = [82, 55, 90, 48, 70, 62, 78, 52, 66, 84, 58, 74];
function skeletonRows(cols, n) {
  const row = '<tr class="sk-row">' + Array.from({ length: cols }, (_, i) => `<td><span class="sk sk-block" style="width:${SK_W[i % SK_W.length]}%"></span></td>`).join("") + "</tr>";
  // Ceiling is the largest page size the app offers (200), not 15 — callers pass their REAL page
  // size, so a 50-row Jobs-database page used to draw 15 skeleton rows and then jump when the real
  // ones arrived. The skeleton exists to hold the height; capping it below the page size defeats it.
  return row.repeat(Math.min(Math.max(n, 4), 200));
}
// A skeleton belongs on a FOREGROUND load (first paint, view/filter/sort/page change) — never on a
// refetch that follows a mutation or runs in the background, which would blank the list the user is
// reading and lose their scroll position. Loaders pass { background: true } for those.
const showTableSkeleton = (id, cols, n = 8) => { const el = $(id); if (el) el.innerHTML = skeletonRows(cols, n); };

// ── List loader plumbing: sequencing + skeleton policy ───────────────────────────────────────────
// (a) SEQUENCING. No list loader used to guard against an older response landing after a newer one,
//     so switching tabs twice quickly — or clicking a company while the server is busy — could leave
//     the table, the result count and the pager all describing a scope the user had already left,
//     with row clicks opening jobs from the stale set. openJobDrawer already solves this with a
//     ++jdReqSeq token; this is the same idea with one counter per list.
// (b) SKELETON POLICY. A skeleton is right for a load the user ASKED for (first paint, view switch,
//     filter, sort, page). It is wrong for a refetch that follows a mutation or arrives from a
//     background fetch: it blanks the list being read and throws away scroll position. Those callers
//     pass { background: true }.  (CLAUDE.md: never toggle a full-surface skeleton on a
//     post-mutation/background refetch.)
// Every mutation should go through here. A bare `await fetch(...)` in a click handler leaves the UI
// stuck mid-action when the server is restarting or wedged — a permanent "Saving…", a Stop button
// that disabled itself and never came back, a delete that silently did nothing — plus an unhandled
// promise rejection. Returns the Response on success, or null after showing the user what failed.
async function mutate(url, init, failMsg = "That didn't go through") {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error || ""; } catch { /* not JSON */ }
      throw new Error(detail || `the server replied ${res.status}`);
    }
    return res;
  } catch (e) {
    toast(`${failMsg} — ${e?.message || "the app couldn't reach the server"}.`, true);
    return null;
  }
}
// Safety net for anything that still slips through: the user gets told, instead of the failure
// existing only in the console.
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled]", e.reason);
  toast("Something didn't reach the server. Check that the engine is running, then try again.", true);
});

// ── Slide-over drawers: the dialog contract ──────────────────────────────────────────────────────
// All seven drawers used to be a bare classList.add("open") on a div that hardcoded aria-hidden
// ="true" in the markup and never removed it. So every one of them — Settings, job detail, signal
// detail, new watchlist, admin edit, the query builder — was invisible to a screen reader WHILE
// VISIBLY OPEN, kept ~95 focusable controls in the tab order while CLOSED (hidden only by a
// transform), never moved focus in, never trapped it, could not be dismissed with Escape, and never
// gave focus back. uiDialog in this same file already did all of this correctly; this is that
// pattern, shared. The closed-state tab stops are handled in CSS (visibility on .drawer).
const drawerStack = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function openDrawer(bgId, drawerId, onClose) {
  const bg = $(bgId), el = $(drawerId);
  if (!bg || !el) return;
  el.removeAttribute("aria-hidden");           // it IS on screen now
  el.inert = false;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  const h = el.querySelector("h2");            // every drawer already renders one
  if (h) { if (!h.id) h.id = drawerId + "-title"; el.setAttribute("aria-labelledby", h.id); }
  drawerStack.push({ el, bg, opener: document.activeElement, onClose });
  labelFields(el);                             // drawer bodies are rendered late, so name their fields now
  bg.classList.add("open"); el.classList.add("open");
  setTimeout(() => {                           // not rAF: an unfocused window can defer that forever
    if (!el.classList.contains("open")) return;
    const first = el.querySelector(FOCUSABLE);
    (first || el).focus?.();
  }, 0);
}
function closeDrawer(bgId, drawerId) {
  const bg = $(bgId), el = $(drawerId);
  if (!bg || !el) return;
  const i = drawerStack.findIndex((e) => e.el === el);
  const entry = i >= 0 ? drawerStack.splice(i, 1)[0] : null;
  bg.classList.remove("open"); el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
  el.inert = true;                             // the guarantee that a closed drawer is untabbable
  el.removeAttribute("aria-modal");
  entry?.opener?.focus?.();                    // back to whatever opened it
}
// One listener drives Escape + the Tab cycle for whichever drawer is on top.
document.addEventListener("keydown", (e) => {
  const top = drawerStack[drawerStack.length - 1];
  if (!top || !top.el.classList.contains("open")) return;
  if (e.key === "Escape") { e.preventDefault(); (top.onClose || (() => closeDrawer(top.bg.id, top.el.id)))(); return; }
  if (e.key !== "Tab") return;
  const f = [...top.el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── .ms-panel open/close ─────────────────────────────────────────────────────────────────────────
// Gives the multiselect popovers the SAME edge-flip and enter/exit motion as their .od-panel
// neighbours on the same toolbar. They were display:none → display:block with no transition and no
// flip: they popped in and out beside a sibling that fades and slides, and the 12-option Category
// list opened downward off the bottom of a short window with no way to reach its last entries.
function msClose(panel) {
  if (!panel || !panel.classList.contains("open")) return;
  panel.classList.remove("in");
  // "closing" goes on NOW so msToggle can tell a panel that is on its way out from an open one.
  // Without it, the 150ms exit window left `open` set, so a click landing in that window was read
  // as another close and the panel simply refused to reopen — the classic swallowed second click.
  panel.classList.add("closing");
  clearTimeout(panel._msT);
  // Keep the handle: reopening inside the 150ms window must CANCEL this, or the stale timer fires
  // afterwards and strips `open` off the panel the user just reopened.
  panel._msT = setTimeout(() => panel.classList.remove("open", "flip", "closing"), 150); // let the exit play, like od's close()
}
/** Place an open panel against its trigger, in VIEWPORT coordinates.
 *
 *  It used to be position:absolute inside the trigger with a `flip` class, which fails twice:
 *  an absolutely-positioned child is clipped by any scrolling ancestor (the Signals toolbar sits
 *  in one, so the 12-option Category list was cut off), and flipping only chooses between two
 *  fixed anchors — on a short window NEITHER side has room and the last entries stay
 *  unreachable. Fixed positioning escapes the clip without moving the node out of the DOM (so
 *  the existing click/stopPropagation wiring is untouched), and the height is capped to whatever
 *  space the chosen side actually has, so the panel scrolls instead of overflowing.
 *
 *  Re-run on scroll/resize while open, or the panel detaches from a trigger that moved. */
function msPosition(panel, btn) {
  const GAP = 6, EDGE = 8, MAXH = 320;
  const r = btn.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const need = Math.min(MAXH, panel.scrollHeight || MAXH);
  // Prefer below; flip only when above genuinely has more room. Either way the cap is the space
  // that side HAS, never the space it wanted.
  const flip = below < need && above > below;
  panel.classList.toggle("flip", flip);
  panel.style.maxHeight = Math.max(120, Math.min(MAXH, flip ? above : below)) + "px";
  panel.style.left = Math.round(Math.max(EDGE, Math.min(r.left, window.innerWidth - panel.offsetWidth - EDGE))) + "px";
  panel.style.top = flip ? "" : Math.round(r.bottom + GAP) + "px";
  panel.style.bottom = flip ? Math.round(window.innerHeight - r.top + GAP) + "px" : "";
  panel._msBtn = btn;
}
// Keep every open panel glued to its trigger. Capture, so a scroll inside any container counts.
const msReposition = () => document.querySelectorAll(".ms-panel.open:not(.closing)").forEach((p) => {
  if (p._msBtn) msPosition(p, p._msBtn);
});
document.addEventListener("scroll", msReposition, true);
window.addEventListener("resize", msReposition);

function msCloseAll(except) {
  document.querySelectorAll(".ms-panel").forEach((p) => { if (p !== except) msClose(p); });
}
function msToggle(panel, btn) {
  // A panel mid-exit still carries `open`; treat it as closed so a quick re-click reopens it.
  if (panel.classList.contains("open") && !panel.classList.contains("closing")) { msClose(panel); return; }
  msCloseAll(panel);
  // Cancel the exit timer from a close that is still mid-flight. Without this the stale timer fires
  // ~150ms after the reopen and strips `open` off the panel the user just reopened — it would blink
  // open and shut on a fast double-click.
  clearTimeout(panel._msT);
  panel.classList.remove("closing");
  panel.classList.add("open");                       // display:block first so scrollHeight is real
  msPosition(panel, btn);
  // rAF gives the transition a frame to start from, but it must not be the ONLY thing that makes
  // the panel visible: a background or unfocused window can defer rAF indefinitely, and the panel's
  // base style is opacity:0, so the dropdown would sit there open, clickable and completely
  // invisible. Belt and braces — whichever fires first wins, adding a class twice is a no-op.
  requestAnimationFrame(() => panel.classList.add("in"));
  setTimeout(() => { if (panel.classList.contains("open")) panel.classList.add("in"); }, 30);
}

const _loadSeq = Object.create(null);
const loadToken = (key) => (_loadSeq[key] = (_loadSeq[key] || 0) + 1);
const loadStale = (key, token) => _loadSeq[key] !== token;
const maybeSkeleton = (opts, id, cols, n) => { if (!opts?.background) showTableSkeleton(id, cols, n); };
// Button busy state: disable + spinner + label while an action is in flight, restore after.
function setBtnLoading(id, loading, label) {
  const b = $(id); if (!b) return;
  if (loading) { if (b.dataset.orig == null) b.dataset.orig = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="btn-spin"></span>${label ? esc(label) : ""}`; }
  else { b.disabled = false; if (b.dataset.orig != null) { b.innerHTML = b.dataset.orig; delete b.dataset.orig; } }
}

// Resilient JSON fetch for the view loaders: 20s timeout + one retry. The server is single-threaded
// (synchronous SQLite) and a heavy fetch can briefly monopolize it — without a timeout the browser
// waits forever and the skeleton shimmers indefinitely. One retry rides out a transient stall; a
// second failure surfaces the "still working" fallback instead of an endless shimmer.
async function fjson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      // fetch only rejects on a NETWORK failure. A 500, a 404, a 502 from a proxy — all of those
      // RESOLVE, and .json() on the error body then either throws something meaningless or, worse,
      // succeeds and hands the caller {error:"..."} , which every loader below reads as data:
      // `(r.items || []).length` is 0, and the surface renders "no results" — a statement about the
      // user's data caused by a server error. That is the exact defect class this file's honesty
      // guards exist for, sitting one level below all of them. Throwing here is what makes every
      // caller's existing catch/retrySoon branch actually run.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }
    catch (e) { if (attempt >= 1) throw e; await new Promise((r) => setTimeout(r, 800)); }
  }
}
// One string served every load failure on every surface, and it asserted a specific cause the app
// has no way to know — a stopped engine, a SQL error and a genuinely busy fetch all read as "a
// background fetch may be hogging the engine". Say what is observable (the request did not come
// back, we are retrying) and point at the one place that can tell them why.
const BUSY_MSG = "Couldn't load this — retrying. If it keeps happening, check System for the engine's status.";
// One pending auto-retry per loader (keyed), so failures self-heal without stacking timers.
const retryTimers = {};
function retrySoon(key, fn, ms = 8000) { clearTimeout(retryTimers[key]); retryTimers[key] = setTimeout(fn, ms); }

/* The empty state for a monitor tab.
 *
 * "No matches for these filters." was the only thing it ever said, and on the commonest way to end up
 * here it is actively misleading: the two monitor tabs are scoped by kind (Client Monitoring reads
 * kind "search", Account Monitoring reads "watchlist"), so if every monitor you own is a watchlist,
 * Client Monitoring is empty no matter what the filters say — and the message sends you off to widen
 * filters that were never the problem. This is the same defect homeOpenCompany was fixed for; it just
 * also needed fixing at the place you actually land.
 *
 * So: name which tab your monitors are on, and give a button that goes there. */
function renderMatchEmpty(rowCount, boxId = "empty", filteredMsg = "No matches for these filters.") {
  const box = $(boxId);
  if (rowCount) { box.style.display = "none"; return; }
  box.style.display = "block";

  const kindOf = (c) => c.kind ?? "search";
  const here = CONFIGS.filter((c) => kindOf(c) === state.kind);
  const elsewhere = CONFIGS.filter((c) => kindOf(c) !== state.kind);

  if (here.length) { box.textContent = filteredMsg; return; }

  const thisTab = state.kind === "watchlist" ? "Account Monitoring" : "Client Monitoring";
  if (!elsewhere.length) {
    box.textContent = `No monitors here yet. Create one and press Fetch, and its results appear on this tab.`;
    return;
  }
  const otherTab = state.kind === "watchlist" ? "Client Monitoring" : "Account Monitoring";
  const otherView = state.kind === "watchlist" ? "clients" : "accounts";
  const n = elsewhere.length;
  box.innerHTML =
    `You have no ${esc(thisTab)} monitors, so this tab is empty whatever the filters say. ` +
    `Your ${n} monitor${n === 1 ? " is" : "s are"} on <b>${esc(otherTab)}</b>: ` +
    `${elsewhere.slice(0, 4).map((c) => esc(c.name)).join(", ")}${n > 4 ? `, and ${n - 4} more` : ""}.` +
    `<div class="empty-cta"><button class="btn" type="button" data-goview="${otherView}">Open ${esc(otherTab)}</button></div>`;
}

// "What matched" cell: for every term the matcher recorded, show WHERE it appears in the job text —
// a highlighted snippet from the exact field it hit (title / description / company / location), so the
// user sees the real matched phrase in context, not just a field name. A detected technology is
// snippeted from title + description; an advanced-rule match shows a single "rule" line (no single
// location). Reads r.matchedOn (Monitors: one JSON array) or r.matchedOnAll (Jobs database: several
// matches' arrays, joined by CHAR(30)). Falls back to the coarse reason when nothing is recorded.
const MATCHED_FIELD_LABEL = { title: "title", description: "description", company: "company", location: "location", industry: "industry", tech: "tech", rule: "rule", anytext: "text" };
function collectMatchedOn(r) {
  const out = [], seen = new Set();
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const add = (arr) => { for (const it of (arr || [])) { if (!it || !it.term) continue; const k = `${it.field}:${it.term}`.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(it); } } };
  if (r.matchedOnAll) for (const p of String(r.matchedOnAll).split(String.fromCharCode(30)).filter(Boolean)) add(parse(p));
  if (r.matchedOn) add(typeof r.matchedOn === "string" ? parse(r.matchedOn) : r.matchedOn);
  return out;
}
// A ~35-char-either-side window around the first occurrence of `term` in `text`, with the hit marked.
function matchSnippet(text, term) {
  text = String(text || ""); term = String(term || "");
  if (!term) return "";
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return `<mark class="mw-hit">${esc(term)}</mark>`; // not literally present (a stemmed/tech hit)
  const pad = 35, s = Math.max(0, i - pad), e = Math.min(text.length, i + term.length + pad);
  const pre = (s > 0 ? "…" : "") + text.slice(s, i);
  const hit = text.slice(i, i + term.length);
  const post = text.slice(i + term.length, e) + (e < text.length ? "…" : "");
  return `${esc(pre)}<mark class="mw-hit">${esc(hit)}</mark>${esc(post)}`;
}
// `explicitItems` (optional) are terms from the CURRENT view filter (the Jobs-database search box /
// technology filter / advanced-filter text conditions). When given, the column shows WHERE your filter
// hit this row — keeping only the terms actually present in this row's text; if none are (the row
// matched via a non-text filter like status), it falls back to the monitor provenance.
function matchedWhereHtml(r, explicitItems) {
  const textFor = (f) => f === "title" ? r.title : f === "description" ? r.description : f === "company" ? r.company
    : f === "location" ? r.location : f === "industry" ? r.industry : (f === "anytext" || f === "tech") ? `${r.title || ""} ${r.description || ""}` : "";
  let items = null;
  if (Array.isArray(explicitItems) && explicitItems.length) {
    const present = explicitItems.filter((it) => it.field !== "rule" && String(textFor(it.field) || "").toLowerCase().includes(String(it.term).toLowerCase()));
    if (present.length) items = present;
  }
  if (!items) items = collectMatchedOn(r); // monitor provenance (or fallback when no filter term is in this row)
  if (!items.length) { const reason = r.matchReason ? esc(r.matchReason) : ""; return `<span class="reason-plain">${reason || '<span style="color:var(--faint)">—</span>'}</span>`; }
  const rows = [];
  for (const it of items) {
    if (rows.length >= 5) break;
    if (it.field === "rule") { rows.push(`<div class="mw-line"><span class="mw-f">rule</span><span class="mw-snip">matched your advanced rule</span></div>`); continue; }
    rows.push(`<div class="mw-line"><span class="mw-f">${esc(MATCHED_FIELD_LABEL[it.field] || String(it.field || ""))}</span><span class="mw-snip">${matchSnippet(textFor(it.field), it.term)}</span></div>`);
  }
  return `<div class="mw-where">${rows.join("")}</div>`;
}
// Terms from the CURRENT Jobs-database filter — the search box, the technology quick filter, and the
// text conditions inside the advanced filter — as matchedOn-style items, so "What matched" can show
// where your filter hit each row (not just what a monitor matched at ingest).
function admFilterMatchItems() {
  const items = [], seen = new Set();
  const add = (term, field) => { term = String(term ?? "").trim(); if (!term) return; const k = field + ":" + term.toLowerCase(); if (seen.has(k)) return; seen.add(k); items.push({ term, field }); };
  const q = ($("admQ").value || "").trim(); if (q) add(q, "anytext");
  for (const t of (adm.techSel || [])) add(t, "tech");
  const TEXT_FIELDS = new Set(["title", "description", "company", "location", "anytext", "industry"]);
  const TEXT_OPS = new Set(["contains", "containsany", "word", "eq", "matches"]);
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n.children)) { n.children.forEach(walk); return; }
    if (n.field === "tech" && (n.op === "has" || n.op === "anyof")) { (Array.isArray(n.value) ? n.value : [n.value]).forEach((v) => add(v, "tech")); return; }
    if (TEXT_FIELDS.has(n.field) && TEXT_OPS.has(n.op)) { (Array.isArray(n.value) ? n.value : [n.value]).forEach((v) => add(v, n.field)); }
  };
  walk(state.adv.admin);
  return items;
}

async function loadMatches(opts) {
  const tok = loadToken("matches");
  maybeSkeleton(opts, "rows", 12, state.limit);
  const p = filterParams();
  p.set("limit", state.limit); p.set("offset", state.offset);
  let data;
  try { data = await fjson("/api/matches?" + p); }
  catch {
    if (loadStale("matches", tok)) return;
    $("rows").innerHTML = `<tr><td colspan="12" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("matches", loadMatches); return;
  }
  if (loadStale("matches", tok)) return; // a newer load started while this one was in flight
  state.total = data.total;
  matchRowsById = {};
  for (const r of data.items) matchRowsById[r.id] = r;
  renderMatchEmpty(data.items.length);
  const lastSeen = lastSeenTs();
  $("rows").innerHTML = data.items.map((r, i) => `
    <tr class="job-row${Number(r.starred) ? ' is-starred' : ''}" data-jobid="${esc(r.id)}" style="--i:${i}">
      <td class="col-triage">
        <button class="tri-btn tri-star${Number(r.starred) ? ' on' : ''}" data-star="${esc(r.id)}" data-tip="${Number(r.starred) ? 'Unstar' : 'Star'}" aria-label="${Number(r.starred) ? 'Unstar' : 'Star'}">${icon(Number(r.starred) ? 'starFill' : 'star')}</button>
        <button class="tri-btn tri-hide" data-hide="${esc(r.id)}" data-tip="Not interested (hide)" aria-label="Hide">${icon('hide')}</button>
      </td>
      <td class="col-client">${(r.clients ? r.clients.split(",") : (r.client ? [r.client] : [])).map(c => `<span class="chip client">${esc(c)}</span>`).join(" ")}</td>
      ${companyCellHtml(r.company, r.domain)}
      <td class="role">${isNew(r.matchedAt, lastSeen) ? '<span class="chip new">NEW</span> ' : ''}${safeUrl(r.url) ? `<a href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</td>
      ${jdCell(r.description)}
      <td class="col-salary" style="white-space:nowrap">${fmtSalary(r)}</td>
      <td>${esc(r.location) || '<span style="color:var(--faint)">—</span>'}</td>
      <td>${r.state ? `<span class="chip state">${esc(r.state)}</span>` : (r.remote ? '<span class="chip remote">remote</span>' : '<span style="color:var(--faint)">—</span>')}</td>
      <td>${r.status === "closed" ? '<span class="chip closed">closed</span>' : '<span class="chip open">open</span>'}</td>
      <td style="white-space:nowrap">${fmtAgoHtml(r.postedAt)}</td>
      <td style="color:var(--faint);white-space:nowrap">${fmtAgoHtml(r.matchedAt)}</td>
      <td class="reason">${matchedWhereHtml(r)}</td>
    </tr>`).join("");
  wireJdCells($("rows"));
  wireJobRows($("rows"), (id) => openJobDrawer(matchRowsById[id]));
  wireTriage($("rows"));
  wireSortHeaders("#viewMonitor thead", "data-msort", () => state.msort, () => state.mdir,
    (k, d) => { state.msort = k; state.mdir = d; state.offset = 0; loadMatches(); });
  renderPager();
  refreshOldSummary();
  markSeen(); // this scope has now been viewed → its unseen count clears
}

// ---- System view: health strip + fetch-run history ----
const runs = { offset: 0, limit: 15, total: 0, sort: "started_at", dir: "desc" };
const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(0) + " KB"; if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB"; return (n / 1073741824).toFixed(2) + " GB"; };
const fmtDur = (s) => { s = Number(s) || 0; return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };
async function loadSystem(opts) {
  try {
    const h = await (await fetch("/api/health")).json();
    const g = h.gate || {};
    const cards = [
      ["Fetch speed", `${g.profile || "normal"}`, `${g.httpInflight || 0}/${g.httpCeiling || 0} in flight${g.cooldownMs ? " · cooldown " + Math.ceil(g.cooldownMs / 1000) + "s" : ""}`],
      ["Jobs stored", fmtNum(h.jobs), `${fmtNum(h.matches)} live matches · ${fmtNum(h.starred)} starred`],
      ["Monitors", fmtNum(h.clients), `${fmtNum(h.accountChecks)} account checks · ${fmtNum(h.atsBoards)} ATS boards`],
      ["Database", fmtBytes(h.dbBytes), `WAL ${fmtBytes(h.walBytes)} · uptime ${fmtDur(h.uptimeSec)}`],
    ];
      // A client that will never fetch, or whose matches will queue undelivered forever, used to say
      // so ONLY in the boot console — behind the window, on a scroll buffer a long boot has already
      // pushed the line off. On screen the client read ACTIVE and the dashboard looked healthy.
      // These are the scheduler's own words, recorded as it armed the timers, and they go FIRST:
      // a setup that cannot run makes every number under it meaningless.
      cards.unshift(...(h.configWarnings || []).map((w) =>
        [w.client, w.kind === "schedule" ? "Won't run by itself" : "Won't be sent", w.warning]));
      // Webhook delivery health. Failures used to exist only as a console.warn on the server, so a
      // user whose endpoint had rotated or started 500ing kept seeing "webhook set" and never learned
      // they had stopped being notified. This card appears only when something is actually failing.
      const df = h.deliveryFailures || [];
      if (df.length) {
        const w = df[0];
        cards.push(["Webhook delivery", `${df.length} failing`,
          `${w.target}: ${w.note}${w.failures > 1 ? ` · ${w.failures} in a row` : ""}`]);
      }
      // Rate-limited signals (GDELT) finish hours after the scan that asked for them, so without a
      // number here "GDELT is showing nothing" looks identical to "GDELT is still working through
      // 1,200 companies". Only shown while work is actually owed.
      // Postings the sweep is DELIBERATELY not closing, because nothing has looked for them since
      // they were last seen. That refusal is correct — "closed" must mean "we checked and it's gone"
      // — but on its own it is silent, and silence here reads as "nothing changed" when the truth is
      // "this source has not run in three weeks". Only shown when a source is actually behind.
      const un = h.unverifiedStale || [];
      if (un.length) {
        const jobs = un.reduce((n, r) => n + (r.jobs || 0), 0);
        const worst = un[0];
        cards.push(["Unverified postings", fmtNum(jobs),
          `${un.length > 1 ? un.length + " sources have" : "this source has"} not been fetched since these were last seen — ` +
          `${worst.originKey} is the largest (${fmtNum(worst.jobs)}). They stay open until something checks.`]);
      }
      // Work that has been found but never handed on. A queued row does NOT mean "no webhook is set"
      // — delivery retires anything with no destination the moment it runs — it means no delivery pass
      // has ever covered it. The rest of the dashboard reads the signals and matches tables directly,
      // never the delivered flag, so without this card a backlog ages for days behind a healthy screen.
      // The headline comes from the server's own COUNT, never from summing the owner rows — those
      // are a top-20 and adding them up would undercount the moment a 21st owner exists.
      const bl = (h.deliveryBacklog && h.deliveryBacklog.owners) || [];
      if (bl.length) {
        const n = h.deliveryBacklog.total || 0;
        const worst = bl[0];
        const days = worst.oldest ? Math.floor((Date.now() - new Date(worst.oldest.replace(" ", "T") + "Z")) / 86400000) : 0;
        cards.push(["Waiting to be sent", fmtNum(n),
          `${worst.owner} has the most (${fmtNum(worst.n)} ${worst.kind}${days >= 1 ? `, oldest ${days} day${days === 1 ? "" : "s"} old` : ""}). ` +
          `These are found but not yet handed to a webhook — they go out on the next delivery pass.`]);
      }
      const q = (h.signalQueue && h.signalQueue.items) || [];
      for (const it of q) {
        if (!it.queued) continue;
        const label = PRODUCER_LABELS[it.producer] || it.producer;
        const s = it.etaSec || 0;
        const eta = s >= 3600 ? `~${(s / 3600).toFixed(1)}h left` : s >= 60 ? `~${Math.round(s / 60)}m left` : "under a minute left";
        cards.push([`${label} queue`, `${fmtNum(it.queued)} waiting`,
          `${eta} at this source's allowed rate${it.failing ? ` · ${fmtNum(it.failing)} retrying` : ""}`]);
      }
    $("sysHealth").innerHTML = cards.map(([l, v, s]) => `<div class="sys-card"><div class="sys-l">${esc(l)}</div><div class="sys-v">${esc(String(v))}</div><div class="sys-s">${esc(s)}</div></div>`).join("");
  } catch { $("sysHealth").innerHTML = '<div class="sys-card"><div class="sys-s">Couldn\'t load health — restart the app to update it.</div></div>'; }
  loadRuns(opts);          // a background System refresh must not blank the run history either
  loadTechLeaderboard();
}
// A run has THREE outcomes, not two. "ok" and "error" were the only ones rendered, so a fetch where a
// board was rejected, a feed was dead or a page cap was hit looked identical to a clean run that
// genuinely found nothing — and the adapters swallow their own failures, so "found 0 jobs" was the
// only thing the user ever saw. src/sources/degraded.ts is the channel; this is where it surfaces.
function runResultChip(r) {
  if (r.error) return `<span class="chip closed" data-tip="${esc(r.error)}">error</span>`;
  if (!r.finishedAt) return '<span class="chip" style="background:var(--accent-soft);color:var(--accent)">live</span>';
  let warns = [];
  try { warns = JSON.parse(r.warnings || "[]"); } catch { warns = []; }
  if (warns.length) {
    const tip = `This fetch worked but was incomplete:\n\n${warns.slice(0, 8).join("\n")}${warns.length > 8 ? `\n… and ${warns.length - 8} more` : ""}`;
    return `<span class="chip" style="background:var(--warn-soft,#fef3c7);color:var(--warn,#92400e)" data-tip="${esc(tip)}">incomplete ${warns.length}</span>`;
  }
  return '<span class="chip open">ok</span>';
}

async function loadRuns(opts) {
  maybeSkeleton(opts, "runsRows", 8, runs.limit);
  const p = new URLSearchParams({ limit: runs.limit, offset: runs.offset, sort: runs.sort, dir: runs.dir });
  const tok = loadToken("runs");
  let d; try { d = await fjson("/api/runs?" + p); } catch { $("runsRows").innerHTML = `<tr><td colspan="8" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("runs", loadRuns); return; }
  if (loadStale("runs", tok)) return;   // a newer sort/page started while this was in flight
  runs.total = d.total;
  $("runsEmpty").style.display = d.items.length ? "none" : "block";
  // "signal-check" fell through to the else and was filed as Client Monitoring — the wrong monitor
  // type entirely, for a run that fetches no jobs at all.
  const kindLabel = (k) => k === "watchlist" ? "Account Monitoring" : k === "account-check" ? "Account Check"
    : k === "signal-check" ? "Signal Check" : "Client Monitoring";
  $("runsRows").innerHTML = d.items.map((r, i) => `
    <tr style="--i:${i}">
      <td style="white-space:nowrap">${fmtAgoHtml(r.startedAt)}</td>
      <td class="company">${esc(r.client || "—")}</td>
      <td><span class="meta">${esc(kindLabel(r.kind))}</span></td>
      <td style="font-variant-numeric:tabular-nums">${fmtNum(r.fetched)}</td>
      <td style="font-variant-numeric:tabular-nums">${fmtNum(r.fresh)}</td>
      <td style="font-variant-numeric:tabular-nums">${fmtNum(r.matched)}</td>
      <td style="white-space:nowrap">${r.finishedAt ? fmtDur(r.durationSec) : '<span style="color:var(--accent)">running…</span>'}</td>
      <td>${runResultChip(r)}</td>
    </tr>`).join("");
  wireSortHeaders("#viewSystem thead", "data-rsort", () => runs.sort, () => runs.dir,
    (k, dir) => { runs.sort = k; runs.dir = dir; runs.offset = 0; loadRuns(); });
  const start = runs.total ? runs.offset + 1 : 0, end = Math.min(runs.offset + runs.limit, runs.total);
  $("runsMeta").textContent = `${fmtNum(runs.total)} run${runs.total === 1 ? "" : "s"}`;
  $("runsPageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(runs.total)}`;
  $("runsPageNum").textContent = `Page ${Math.floor(runs.offset / runs.limit) + 1} of ${Math.max(1, Math.ceil(runs.total / runs.limit))}`;
  $("runsPrev").disabled = runs.offset === 0; $("runsNext").disabled = end >= runs.total;
}
$("runsPrev").onclick = () => { runs.offset = Math.max(0, runs.offset - runs.limit); loadRuns(); };
$("runsNext").onclick = () => { runs.offset += runs.limit; loadRuns(); };

// ---- Top-technologies leaderboard (System view) ----
let techLbScope = "search";
async function loadTechLeaderboard() {
  const box = $("techLb"); if (!box) return;
  let d; try { d = await fjson("/api/technologies/leaderboard?kind=" + encodeURIComponent(techLbScope)); } catch { box.innerHTML = `<div class="skel" style="padding:14px">${BUSY_MSG}</div>`; retrySoon("techLb", loadTechLeaderboard); return; }
  box.innerHTML = techLbRows(d.items || []); wireTechLbClicks(box);
}
$("techLbScope").querySelectorAll("button").forEach((b) => b.onclick = () => {
  techLbScope = b.dataset.v;
  $("techLbScope").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  loadTechLeaderboard();
});

// ---- Technologies view (dedicated tab): dictionary search + in-scope leaderboard → drill into Jobs ----
// Drill-in: select a technology in the Jobs-database quick filter and jump there. Mutate techSel IN PLACE
// (the pill closure holds this exact array reference), then rebuild the pill so its label/chips repaint.
function openTechInJobs(name) {
  // Clear the Jobs database's existing state FIRST. Keeping the old page offset and text filters
  // meant a drill-in could land on page 3 of a technology with 20 jobs and show "no records" while
  // the toast said the opposite — the filter was applied on top of a scope the user had left behind.
  admClearScope();                    // a real clear — admReset() only rewound the page offset
  adm.techSel.push(name);
  buildTechFilter("msAdmTechPanel", "msAdmTechBtn", adm.techSel, admReset);
  showView("admin"); // loads the Jobs database with the technology filter applied
  toast(`Showing jobs that mention ${name}`);
}
// One clickable leaderboard-row renderer, shared by the System panel and the Technologies view.
function techLbRows(items) {
  if (!items.length) return '<div class="empty" style="padding:18px">No technologies detected in matched postings yet. Run a fetch, or widen the scope.</div>';
  const max = items[0].jobs || 1;
  return items.map((t) => `
    <button type="button" class="tlb-row" data-tech="${esc(t.name)}" data-tip="Show jobs using ${esc(t.name)}${t.category ? " · " + esc(t.category) : ""}">
      <span class="tlb-name">${esc(t.name)}</span>
      <span class="tlb-bar"><span class="tlb-fill" style="width:${Math.max(4, Math.round((t.jobs / max) * 100))}%"></span></span>
      <span class="tlb-n">${fmtNum(t.jobs)}</span>
    </button>`).join("");
}
const wireTechLbClicks = (box) => box.querySelectorAll('[data-tech]').forEach(b => b.onclick = () => openTechInJobs(b.dataset.tech));

let techViewScope = "search";
async function loadTechViewLeaderboard() {
  const box = $("techViewLb"); if (!box) return;
  const tok = loadToken("techViewLb");
  let d; try { d = await fjson("/api/technologies/leaderboard?kind=" + encodeURIComponent(techViewScope)); } catch { box.innerHTML = `<div class="skel" style="padding:14px">${BUSY_MSG}</div>`; retrySoon("techViewLb", loadTechViewLeaderboard); return; }
  if (loadStale("techViewLb", tok)) return;   // the scope switched while this was in flight
  box.innerHTML = techLbRows(d.items || []); wireTechLbClicks(box);
}
let techViewSearchWired = false, techViewWired = false, techViewT;
let techState = { offset: 0, limit: 15, total: 0, mode: "browse", sort: null, dir: "desc" }; // 15 = the shared default, and 60 was not even on the app's own {15,25,50,100} ladder
// One row renderer + click-wire, shared by the default browse list and the search results.
// A plain readable 2-column table (Technology · Category) — click a row to drill into its jobs.
function techViewRender(items, emptyMsg) {
  const body = $("techViewRows");
  body.innerHTML = items.length
    ? items.map((it) => `
      <tr class="tech-row" data-tech="${esc(it.name)}" data-tip="Show jobs that mention ${esc(it.name)}">
        <td class="tech-nm">${esc(it.name)}</td>
        <td class="tech-cat">${it.category ? esc(it.category) : '<span class="qb-dash">—</span>'}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="empty" style="padding:34px 18px">${esc(emptyMsg)}</td></tr>`;
  body.querySelectorAll("[data-tech]").forEach((r) => r.onclick = () => openTechInJobs(r.dataset.tech));
}
function renderTechPager() {
  const pager = $("techPager"); if (!pager) return;
  if (techState.mode !== "browse" || techState.total <= techState.limit) { pager.style.display = "none"; return; }
  pager.style.display = "";
  const start = techState.total ? techState.offset + 1 : 0, end = Math.min(techState.offset + techState.limit, techState.total);
  $("techPageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(techState.total)}`;
  $("techPageNum").textContent = `Page ${Math.floor(techState.offset / techState.limit) + 1} of ${Math.max(1, Math.ceil(techState.total / techState.limit))}`;
  $("techPrev").disabled = techState.offset === 0;
  $("techNext").disabled = end >= techState.total;
}
// Default (no query): browse the dictionary, most-adopted first, PAGINATED — so the tab actually SHOWS
// technologies and scales past the top handful.
async function techViewBrowse() {
  techState.mode = "browse";
  showTableSkeleton("techViewRows", 2, 12);
  const tok = loadToken("techView");   // shared with techViewSearch — both paint #techViewRows
  let items = [], total = 0;
  const sp = techState.sort ? `&sort=${techState.sort}&dir=${techState.dir}` : "";
  try { const d = await fjson(`/api/technologies?limit=${techState.limit}&offset=${techState.offset}${sp}`); items = d.items || []; total = d.total || d.count || items.length; }
  catch { $("techViewRows").innerHTML = `<tr><td colspan="2" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("techBrowse", techViewBrowse); return; }
  if (loadStale("techView", tok)) return;
  techState.total = total;
  // Sortable columns over all 29k technologies, server-side (the list had none at all).
  wireSortHeaders("#techHead", "data-techsort", () => techState.sort, () => techState.dir,
    (k, dir) => { techState.sort = k; techState.dir = dir; techState.offset = 0; techViewBrowse(); });
  const cnt = $("techViewCount"); if (cnt) cnt.textContent = total ? `${fmtNum(total)} technologies` : "";
  const guide = $("techViewGuide");
  if (guide) guide.textContent = total
    ? "Most-adopted first. Type to search the whole dictionary; click any technology to see every job that mentions it."
    : "Import a technology list in Settings to populate the dictionary.";
  techViewRender(items, "No technologies in the dictionary yet.");
  renderTechPager();
}
// Show/hide the Top-in-your-postings panel — OFF by default, matching the companies side panel. Persisted.
const TECH_LB_KEY = "se_techlb";
function applyTechLb() {
  const on = localStorage.getItem(TECH_LB_KEY) === "1";
  $("techGrid")?.classList.toggle("no-side", !on);
  const btn = $("techLbToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const lbl = $("techLbToggleLbl"); if (lbl) lbl.textContent = on ? "Hide panel" : "Top technologies";
  }
  if (on) loadTechViewLeaderboard();
}
function loadTechnologiesView() {
  applyTechLb();          // loads the leaderboard only if the panel is shown
  techState.offset = 0;
  techViewBrowse();
  const input = $("techViewSearch");
  if (input && !techViewSearchWired) {
    techViewSearchWired = true;
    input.oninput = () => {
      const q = input.value.trim(); clearTimeout(techViewT);
      if (!q) { techState.offset = 0; techViewBrowse(); return; } // cleared → back to the paginated browse list
      if (q.length < 2) return;
      techViewT = setTimeout(async () => {
        techState.mode = "search";
        // Same counter as techViewBrowse — they write the same table, and a slow search landing
        // after the user cleared the box (which starts a browse) painted the search results back
        // over the browse list. The review reproduced exactly this.
        const tok = loadToken("techView");
        let items = [];
        try { items = await techLookup(q); }
        catch { techViewRender([], "Couldn\u2019t reach the dictionary just now — the engine may be busy. Try again in a moment."); return; }
        if (loadStale("techView", tok)) return;
        techViewRender(items, "No match in the dictionary.");
        renderTechPager(); // hides the pager in search mode
      }, 160);
    };
  }
  if (!techViewWired) {
    techViewWired = true;
    const techScroll = () => document.querySelector("#viewTechnologies .tech-tbl-scroll");
    $("techPrev").onclick = () => { techState.offset = Math.max(0, techState.offset - techState.limit); techViewBrowse(); const s = techScroll(); if (s) s.scrollTop = 0; };
    $("techNext").onclick = () => { techState.offset += techState.limit; techViewBrowse(); const s = techScroll(); if (s) s.scrollTop = 0; };
    $("techLbToggle").onclick = () => {
      localStorage.setItem(TECH_LB_KEY, localStorage.getItem(TECH_LB_KEY) === "1" ? "0" : "1");
      applyTechLb();
    };
    $("techViewScope").querySelectorAll("button").forEach((b) => b.onclick = () => {
      techViewScope = b.dataset.v;
      $("techViewScope").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      loadTechViewLeaderboard();
    });
  }
}

// ---- Signals view: the non-hiring sales-signal feed (velocity, tech changes, …) ----
// Signal labels + explanations now live server-side in src/signals/taxonomy.ts (ONE source of
// truth shared with the Guide, the pill colours and webhook routing) and arrive via ensureTaxonomy().
let SIGNAL_TYPES = [], SIGNAL_CATEGORIES = [];
// Short glossary for jargon that shows up inside EDGAR facts.
const SIGNAL_GLOSSARY = {
  CIK: "CIK = Central Index Key, the SEC's unique ID number for a company.",
  "Form D": "Form D = the filing for a private capital raise (a funding round).",
  "8-K": "8-K = a filing for a major corporate event (acquisition, exec change, etc.).",
  "S-1": "S-1 = the registration a company files to go public (IPO).",
};
const sigState = { client: "", typeSel: [], catSel: [], q: "", since: "", history: false, group: true, offset: 0, limit: 15, total: 0, sort: null, dir: "desc" };
// Signal meaning comes from ONE server-side source of truth (src/signals/taxonomy.ts) via
// /api/signals/taxonomy — the same map the feed, the Guide, the pill colours and webhook routing use,
// so they can never drift. Lazily fetched once, mirroring the SIG_PRODUCERS pattern.
let SIG_TAX = null, TYPE_META = {};
async function ensureTaxonomy() {
  if (SIG_TAX) return SIG_TAX;
  let fetched;
  // Do NOT cache the empty fallback. Assigning it to SIG_TAX made the `if (SIG_TAX) return` guard
  // above short-circuit every later call, so one timed-out request left signal pills showing raw
  // type keys, every category coloured "other", both feed filters empty and the Guide blank for the
  // WHOLE session. sigProducers() next door already gets this right — it returns [] without
  // poisoning its cache, so the next call retries.
  try { fetched = await fjson("/api/signals/taxonomy"); }
  // The empty shape is a genuine fallback — without it, pills render raw type keys, which is
  // degraded but not untrue. What was missing is the retry: one timeout left the feed's two
  // filters empty until the next full reload.
  catch { retrySoon("taxonomy", ensureTaxonomy); return { categories: [], types: [] }; }
  SIG_TAX = fetched;
  SIGNAL_TYPES = SIG_TAX.types.map((t) => [t.type, t.label]);
  SIGNAL_CATEGORIES = SIG_TAX.categories;
  TYPE_META = Object.fromEntries(SIG_TAX.types.map((t) => [t.type, t]));
  return SIG_TAX;
}
const sigCategory = (type) => (TYPE_META[type] || {}).category || "other";
const sigLabel = (type) => (TYPE_META[type] || {}).label || type;
/** Offer to put a just-dismissed signal back. Mirrors the job-hide Undo, which has always had one. */
function undismissToast(id) {
  toastUndo("Signal dismissed.", async () => {
    const ok = await mutate(`/api/signals/${id}/dismiss`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dismissed: false }),
    }, "Could not restore that signal");
    if (ok) loadSignals({ background: true });
  });
}
// How this signal got attached to this company. Unknown types default to "name" — the cautious
// answer, matching src/signals/taxonomy.ts, so a type the UI hasn't heard of is never printed as a
// first-hand observation.
const sigAttribution = (type) => (TYPE_META[type] || {}).attribution || "name";
const NAME_MATCH_TIP = "Matched to this company by NAME in a third-party source (news, a filing index, a registry) — not observed on their own domain. Names are ambiguous, so open the source and confirm it is really them.";
// The badge is rendered ONLY for name-matched signals. A "direct" badge on everything else would
// be noise on the majority of rows; absence of the warning is the normal case.
const sigBasisChip = (type) => sigAttribution(type) === "name"
  ? ` <span class="sig-basis" data-tip="${esc(NAME_MATCH_TIP)}" aria-label="Matched by name — verify the source">name match</span>` : "";
const sigExplain = (type) => (TYPE_META[type] || {}).explain || "";
const catLabel = (key) => (SIGNAL_CATEGORIES.find((c) => c.key === key) || {}).label || key;
let sigWired = false, sigRowsById = {};
const sigParseDetail = (s) => { try { return s.detail ? (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) : null; } catch { return null; } };

// ── Guide page ──────────────────────────────────────────────────────────────────────────────────────
// The glossary is grouped by the SAME categories the feed filters and colours by (from
// /api/signals/taxonomy), so it can never drift — and a regional variant of an event (a UK share
// allotment, a non-English funding headline) lands under the same heading as its US counterpart.
let guideBuilt = false;
async function renderGuide() {
  if (guideBuilt) return; guideBuilt = true;
  await ensureTaxonomy();
  const host = $("guideSignals"); if (!host) return;
  host.innerHTML = "";
  // One section per category that actually has signal types, in the taxonomy's display order.
  const order = [], byKey = {};
  for (const c of SIGNAL_CATEGORIES) {
    const rows = SIGNAL_TYPES.filter(([t]) => sigCategory(t) === c.key);
    if (!rows.length) continue;                       // e.g. the "other" fallback with nothing in it
    byKey[c.key] = { label: c.label, blurb: c.blurb || "", rows };
    order.push(byKey[c.key]);
  }
  for (const grp of order) {
    const fam = document.createElement("div"); fam.className = "g-fam";
    fam.innerHTML = `<div class="g-fam-h">${esc(grp.label)}${grp.blurb ? ` <span class="g-fam-blurb">${esc(grp.blurb)}</span>` : ""}</div>`;
    for (const [t, lab] of grp.rows) {
      const row = document.createElement("div"); row.className = "g-sig"; row.dataset.q = (t + " " + lab + " " + sigExplain(t)).toLowerCase();
      row.innerHTML = `<span class="g-sig-label">${esc(lab)}</span><span class="g-sig-desc">${esc(sigExplain(t) || "—")}</span>`;
      fam.appendChild(row);
    }
    host.appendChild(fam);
  }
  // glossary
  const gl = $("guideGlossary");
  if (gl) {
    const terms = [
      ["ATS", "Applicant-Tracking System — the software a company runs its hiring through (Greenhouse, Lever, Ashby, Workday…)."],
      ["MX record", "The DNS record that says which service handles a domain's email (Google, Microsoft, Zoho…)."],
      ["SPF record", "A DNS record listing which tools are allowed to send email as a company — reveals tools like Klaviyo, HubSpot, Outreach."],
      ["Form D", "The SEC filing a company submits when it raises private capital — a funding round, even with no press release."],
      ["8-K", "An SEC filing for a major corporate event: an acquisition, an executive change, big news."],
      ["S-1", "The SEC registration a company files to go public (IPO prep)."],
      ["CIK", "Central Index Key — the SEC's unique ID number for a filer."],
      ["WARN notice", "A state government filing large employers must submit in advance before layoffs or a plant closure."],
      ["crt.sh", "A public log of SSL certificates — new subdomains show up here first (app., shop., docs.)."],
      ["Baseline", "The first scan of a company. The 10 diff-based signals record current state and emit nothing, so you don't get flooded with old news. Hiring velocity, WARN notices, Product Hunt launches and \"app gone stale\" DO fire on the first scan — each is a dated event, not a change, so there is nothing to diff against."],
      ["Webhook", "A URL HyperSignal POSTs new matches/signals to, so they flow into your own tools automatically."],
    ];
    gl.innerHTML = terms.map(([t, d]) => `<div class="g-term"><span class="g-term-k">${esc(t)}</span><span class="g-term-d">${esc(d)}</span></div>`).join("");
  }
  // search filter
  const box = $("guideSigSearch");
  if (box) box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    host.querySelectorAll(".g-fam").forEach((fam) => {
      let any = false;
      fam.querySelectorAll(".g-sig").forEach((r) => { const hit = !q || r.dataset.q.includes(q); r.style.display = hit ? "" : "none"; if (hit) any = true; });
      fam.style.display = any ? "" : "none";
    });
  });
}

async function loadSignalStats() {
  const box = $("sigStats"); if (!box) return;
  const tok = loadToken("sigStats");
  let s;
  // Pass the grouping toggle: the KPI strip and the breakdown sit directly above the feed, so they
  // must count the rows the feed shows, not the raw reports behind them.
  const sp = new URLSearchParams();
  if (sigState.client) sp.set("client", sigState.client);
  if (!sigState.group) sp.set("group", "0");
  try { s = await fjson("/api/signals/stats" + (sp.toString() ? "?" + sp : "")); }
  catch { return; } // keep last values
  if (loadStale("sigStats", tok)) return;   // a newer monitor filter is already on screen
  const cards = [
    ["Signals", fmtNum(s.total)],
    ["New (24h)", fmtNum(s.last24h)],
    ["Companies", fmtNum(s.companies)],
    ["Top signal", s.topCategory ? catLabel(s.topCategory.category) : "—", s.topCategory ? `${fmtNum(s.topCategory.c)} of ${fmtNum(s.total)}` : ""],
  ];
  box.innerHTML = cards.map(([l, n, sub]) => `<div class="stat"><div class="n" style="${String(n).length > 10 ? "font-size:15px" : ""}">${esc(String(n))}</div><div class="l">${esc(l)}${sub ? ` · ${esc(sub)}` : ""}</div></div>`).join("");
  renderSigBreakdown(s.byCategory || []);
}

// Breakdown grid under the KPI cards: one clickable cell per CATEGORY found — so a raise counts once
// as "Funding" instead of splitting across four source-specific rows. Click filters the feed.
function renderSigBreakdown(byCategory) {
  const box = $("sigBreakdown"); if (!box) return;
  if (!byCategory.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "flex"; // matches the .sig-breakdown stylesheet (flex-wrap grows the last row)
  box.innerHTML = byCategory.map((t) => {
    const active = sigState.catSel.length === 1 && sigState.catSel[0] === t.category;
    const fresh = t.last24h > 0 ? `<span class="sb-new">+${fmtNum(t.last24h)} today</span>` : "";
    const blurb = (SIGNAL_CATEGORIES.find((c) => c.key === t.category) || {}).blurb || "";
    return `<button class="sb-cell${active ? " on" : ""}" data-cat="${esc(t.category)}" data-tip="${esc(blurb || catLabel(t.category))}">
      <span class="sb-dot sig-cat-${esc(t.category)}"></span>
      <span class="sb-label">${esc(catLabel(t.category))}</span>
      <span class="sb-meta">${fresh}<span class="sb-count">${fmtNum(t.c)}</span></span>
    </button>`;
  }).join("");
  box.querySelectorAll(".sb-cell").forEach((el) => {
    el.onclick = () => {
      const cat = el.getAttribute("data-cat");
      // Toggle: clicking the already-filtered category clears it. Mutate catSel IN PLACE — the
      // Category multiselect closed over this exact array reference, so reassigning it would desync
      // the dropdown from the applied filter (matches the app's openTechInJobs pattern).
      const wasActive = sigState.catSel.length === 1 && sigState.catSel[0] === cat;
      sigState.catSel.length = 0;
      if (!wasActive) sigState.catSel.push(cat);
      const btn = $("msSigCatBtn");
      if (btn) btn.innerHTML = `Category: ${sigState.catSel.length ? sigState.catSel.length + " selected" : "any"} <span class="caret">${icon('chevron')}</span>`;
      const panel = $("msSigCatPanel");
      if (panel) panel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = sigState.catSel.includes(cb.value); });
      sigState.offset = 0; loadSignals();
    };
  });
}
// Keep the "Signal" multiselect button label in sync when the breakdown changes the filter.
function syncSigTypeBtn() {
  const btn = $("msSigTypeBtn"); if (!btn) return;
  btn.innerHTML = `Signal: ${sigState.typeSel.length ? sigState.typeSel.length + " selected" : "any"} <span class="caret">${icon('chevron')}</span>`;
  const panel = $("msSigTypePanel");
  if (panel) panel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = sigState.typeSel.includes(cb.value); });
}

/** The feed's filters as a query string, WITHOUT pagination. The list request and the CSV export
 *  both build from this, so an export can never quietly cover a different set than the screen. */
function sigFilterParams() {
  const p = new URLSearchParams();
  if (sigState.client) p.set("client", sigState.client);
  if (sigState.typeSel.length) p.set("types", sigState.typeSel.join(","));
  if (sigState.catSel.length) p.set("categories", sigState.catSel.join(","));
  if (sigState.q) p.set("q", sigState.q);
  if (sigState.since) p.set("since", sigState.since);        // event-date range (from the "When" filter)
  if (sigState.history) p.set("history", "1");               // include dismissed = full record
  if (!sigState.group) p.set("collapse", "0");               // "Group similar" off = one row per report
  if (sigState.sort) { p.set("sort", sigState.sort); p.set("dir", sigState.dir); }
  return p;
}
async function loadSignals(opts) {
  const tok = loadToken("signals");
  maybeSkeleton(opts, "sigRows", 6, sigState.limit);
  await ensureTaxonomy();
  loadSignalStats();
  const p = sigFilterParams();
  p.set("limit", sigState.limit); p.set("offset", sigState.offset);
  let d;
  try { d = await fjson("/api/signals?" + p); }
  catch {
    if (loadStale("signals", tok)) return;
    $("sigRows").innerHTML = `<tr><td colspan="6" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("signals", loadSignals); return;
  }
  if (loadStale("signals", tok)) return;
  sigState.total = d.total;
  // No change-events yet → never leave the tab blank: show CURRENT signals (present state) instead.
  // Only when the plain feed is empty AND the user has not scoped it — an empty result under a filter
  // is an ANSWER, not a blank tab to paper over.
  // `client` and `since` were missing from this list, so choosing a monitor with no signals, or a
  // narrow time window, silently discarded that filter and showed other companies' current state
  // under a note that never mentioned it. `q` deliberately stays out of the list: the fallback DOES
  // forward the search term, so a search remains correctly scoped and is still worth falling back to.
  const scoped = sigState.history || sigState.typeSel.length || sigState.catSel.length
    || sigState.client || sigState.since;
  if (d.total === 0 && !scoped) return renderCurrentSignalsFallback();
  $("sigFallbackNote").style.display = "none";
  sigRowsById = {};
  for (const r of d.items) sigRowsById[r.id] = r;
  $("sigEmpty").style.display = d.items.length ? "none" : "block";
  $("sigMeta").textContent = `${fmtNum(d.total)} signal${d.total === 1 ? "" : "s"}`;
  $("sigRows").innerHTML = d.items.map((s, i) => {
    const detail = sigParseDetail(s);
    const sub = detail && typeof detail === "object"
      ? Object.entries(detail).filter(([, v]) => v != null && v !== "").slice(0, 2).map(([k, v]) => esc(String(v))).join(" · ") : "";
    const safeUrl = s.url && /^https?:\/\//i.test(s.url) ? s.url : "";
    return `<tr class="sig-row" data-id="${s.id}" style="--i:${i}">
      <td style="white-space:nowrap">${fmtAgoHtml(s.observedAt || s.createdAt)}</td>
      ${companyCellHtml(s.company, s.domain, { emptyDash: false })}
      <td><span class="sig-pill sig-cat-${esc(sigCategory(s.type))}" data-tip="${esc(sigExplain(s.type) || s.type)}">${esc(sigLabel(s.type))}</span></td>
      <td><div class="sig-title">${safeUrl
        ? `<a class="sig-src" href="${esc(safeUrl)}" target="_blank" rel="noopener" data-tip="Open the source where this signal was found">${esc(s.title)} ${icon("external")}</a>`
        : esc(s.title)}${sigBasisChip(s.type)}${Number(s.groupCount) > 1
        // "sources" claimed corroboration this row cannot support: the members are merely reports of
        // the same KIND of event for the same company inside the collapse window, and a name-matched
        // one can be about somebody else entirely. "related" says what is actually true, and the
        // tooltip names the merge rule instead of asserting they are the same event.
        ? `<button class="sig-more" data-more="${s.id}" data-tip="${Number(s.groupCount)} reports of this kind for this company within the grouping window, merged into one row. Click to see them — each shows how it was matched." aria-expanded="false">+${Number(s.groupCount) - 1} related</button>` : ""
        }</div>${sub ? `<div class="sig-detail">${sub}</div>` : ""}</td>
      <td>${s.client ? `<span class="chip client">${esc(s.client)}</span>` : (s.checkId ? '<span class="chip" style="background:var(--accent-soft);color:var(--accent)">check</span>' : '<span style="color:var(--faint)">—</span>')}</td>
      <td style="text-align:right"><button class="sig-dismiss" data-dismiss="${s.id}" data-tip="Dismiss this signal" aria-label="Dismiss signal">${icon('x')}</button></td>
    </tr>`;
  }).join("");
  // whole row → detail drawer; the dismiss button stops propagation
  $("sigRows").querySelectorAll(".sig-row").forEach((tr) => rowActivate(tr, () => openSignalDrawer(sigRowsById[tr.dataset.id])));
  // "+N more sources" → expand a sibling row listing the OTHER reports of the same event.
  $("sigRows").querySelectorAll("[data-more]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const tr = b.closest("tr"), open = tr.nextElementSibling?.classList.contains("sig-srcrow");
    if (open) {
      // Play the exit instead of vanishing: the row animates IN via the shared `tbody tr` rowIn
      // keyframe, so an instant .remove() made expand and collapse feel like different components.
      const row = tr.nextElementSibling;
      row.classList.add("sig-srcrow-out");
      row.addEventListener("animationend", () => row.remove(), { once: true });
      setTimeout(() => row.remove(), 400); // belt-and-braces if the animation is disabled
      b.setAttribute("aria-expanded", "false");
      b.textContent = b.dataset.moreLabel || b.textContent;
      return;
    }
    const s = sigRowsById[b.dataset.more] || {};
    const others = (s.sources || []).filter((x) => String(x.id) !== String(s.id))
      .sort((a, c) => (c.rank - a.rank) || String(c.observedAt || "").localeCompare(String(a.observedAt || "")));
    const row = document.createElement("tr");
    row.className = "sig-srcrow";
    row.innerHTML = `<td colspan="6">${others.map((o) => {
      const u = o.url && /^https?:\/\//i.test(o.url) ? o.url : "";
      return `<div class="sig-src"><span class="sb-dot sig-cat-${esc(sigCategory(o.type))}"></span>
        <span class="meta">${esc(sigLabel(o.type))}</span>
        ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(o.title)}</a>` : esc(o.title)}${sigBasisChip(o.type)}
        <span class="sig-src-when">${esc(fmtAgo(o.observedAt))}</span></div>`;
        // .sig-src-when already styles this, so the plain-text variant is what belongs here —
        // and it is now safe to esc(), which is what printed the literal tag before.
    }).join("") || '<span class="meta">No other sources.</span>'}</td>`;
    tr.after(row);
    // Expanded state must be visible AND announced — the chip kept the same "+N more sources" label
    // whether open or closed, and carried no aria-expanded at all.
    if (!b.dataset.moreLabel) b.dataset.moreLabel = b.textContent;
    b.setAttribute("aria-expanded", "true");
    b.textContent = "Hide";
  });
  $("sigRows").querySelectorAll("[data-dismiss]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    // Dismiss is reversible — the endpoint already takes { dismissed: false } — but nothing in the
    // UI offered it, so a mis-click was permanent with no un-dismiss control anywhere.
    if (!await mutate(`/api/signals/${b.dataset.dismiss}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, "Could not dismiss that signal")) return;
    loadSignals({ background: true });
    undismissToast(b.dataset.dismiss);
  });
  // Sortable columns, like every other table in the app. Server-side, so a sort orders the whole
  // signal set rather than reshuffling the 15 rows that happen to be on screen.
  wireSortHeaders("#sigHead", "data-sigsort", () => sigState.sort, () => sigState.dir,
    (k, dir) => { sigState.sort = k; sigState.dir = dir; sigState.offset = 0; loadSignals(); });
  const start = d.total ? sigState.offset + 1 : 0, end = Math.min(sigState.offset + sigState.limit, d.total);
  $("sigPageInfo").textContent = d.total ? `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(d.total)}` : "";
  $("sigPageNum").textContent = `Page ${Math.floor(sigState.offset / sigState.limit) + 1} of ${Math.max(1, Math.ceil(d.total / sigState.limit))}`;
  $("sigPrev").disabled = sigState.offset === 0; $("sigNext").disabled = end >= d.total;
}
// Friendly labels for the current-state pills (domain_flags.producer keys → human names).
const PRODUCER_LABELS = { velocity: "Hiring", dns: "Email tools", ats: "Hiring tools", tech: "Website tech",
  subdomains: "Web presence", edgar: "SEC / funding", companieshouse: "UK filings", apps: "Mobile apps", news: "News",
  gdelt: "Global news", warn: "Layoffs", ph: "Product Hunt", ads: "Ads" };
// Fallback when the change-feed is empty: show CURRENT signals so the tab is never blank (and explains itself).
async function renderCurrentSignalsFallback() {
  const p = new URLSearchParams();
  if (sigState.q) p.set("q", sigState.q);
  p.set("limit", sigState.limit); p.set("offset", sigState.offset);
  let d; try { d = await fjson("/api/signals/current?" + p); }
  catch { $("sigRows").innerHTML = `<tr><td colspan="6" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("signals", loadSignals); return; }
  sigState.total = d.total;
  if (!d.total) { // truly nothing yet — helpful empty state
    $("sigFallbackNote").style.display = "none";
    $("sigRows").innerHTML = "";
    $("sigEmpty").style.display = "block";
    $("sigEmpty").innerHTML = 'No signals yet. Signals come from <b>watchlists</b>: turn signal types on, run a fetch, and the feed fills as things change — or check a company right now.'
      + '<div class="empty-cta"><button class="btn" type="button" data-goview="accounts">Open Account Monitoring</button><button class="btn" type="button" data-gosigtab="checks">Run a check</button></div>';
    $("sigMeta").textContent = "0 signals";
    $("sigPageInfo").textContent = ""; $("sigPageNum").textContent = ""; $("sigPrev").disabled = true; $("sigNext").disabled = true;
    return;
  }
  $("sigEmpty").style.display = "none";
  $("sigFallbackNote").style.display = "block";
  $("sigFallbackNote").innerHTML = 'No signal <b>changes</b> to report yet — showing the <b>current</b> signals for your tracked companies. This feed fills with new rows as things change (a company starts running ads, switches hiring tools, raises money…).';
  $("sigRows").innerHTML = d.items.map((s, i) => `<tr class="sig-row sig-current" style="--i:${i}">
      <td style="white-space:nowrap">${fmtAgoHtml(s.checkedAt)}</td>
      ${companyCellHtml(s.company, s.domain, { emptyDash: false })}
      <td><span class="sig-pill pill-cur">${esc(PRODUCER_LABELS[s.producer] || s.producer)}</span></td>
      <td><div class="sig-title">${esc(s.summary || "—")}</div></td>
      <td><span class="chip" style="background:var(--accent-soft);color:var(--accent)">now</span></td>
      <td style="text-align:right"><span style="color:var(--faint)">—</span></td>
    </tr>`).join("");
  $("sigMeta").textContent = `${fmtNum(d.total)} current signal${d.total === 1 ? "" : "s"}`;
  const start = sigState.offset + 1, end = Math.min(sigState.offset + sigState.limit, d.total);
  $("sigPageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(d.total)}`;
  $("sigPageNum").textContent = `Page ${Math.floor(sigState.offset / sigState.limit) + 1} of ${Math.max(1, Math.ceil(d.total / sigState.limit))}`;
  $("sigPrev").disabled = sigState.offset === 0; $("sigNext").disabled = end >= d.total;
}

// Signal detail drawer — mirrors the job drawer: title + type pill, facts grid, attribution, source link.
const closeSigDrawer = () => { closeDrawer("sigBg", "sigDrawer"); };
function openSignalDrawer(s) {
  if (!s) return;
  const footer = $("sigDrawerFoot"); if (footer) footer.style.display = ""; // restore (openDomainCheck hides it)
  const detail = sigParseDetail(s);
  $("sigDTitle").textContent = sigLabel(s.type);
  const factRows = detail && typeof detail === "object"
    ? Object.entries(detail).filter(([, v]) => v != null && v !== "" && typeof v !== "object")
        .map(([k, v]) => `<div class="jd-fact"><span class="jd-fk">${esc(k)}</span><span class="jd-fv">${esc(String(v))}</span></div>`).join("")
    : "";
  const when = fmtTime(s.observedAt || s.createdAt);
  const explain = sigExplain(s.type);
  const basis = sigAttribution(s.type);
  const grouped = (s.sources || []).filter((x) => String(x.id) !== String(s.id))
    .sort((a, c) => (c.rank - a.rank) || String(c.observedAt || "").localeCompare(String(a.observedAt || "")));
  // Show a jargon glossary only for the terms actually present in this signal (EDGAR codes etc.).
  const hay = (s.title + " " + JSON.stringify(detail || "")).toLowerCase();
  const glossary = Object.entries(SIGNAL_GLOSSARY).filter(([term]) => hay.includes(term.toLowerCase())).map(([, def]) => def);
  $("sigDBody").innerHTML = `
    <div class="jd-head">
      <span class="sig-pill sig-cat-${esc(sigCategory(s.type))}">${esc(sigLabel(s.type))}</span>${sigBasisChip(s.type)}
      <div class="sig-drawer-title">${esc(s.title)}</div>
      <div class="jd-co">${s.company ? esc(s.company) : ""}${s.domain ? ` · <a href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a>` : ""}</div>
    </div>
    ${explain ? `<div class="sig-explain">${esc(explain)}</div>` : ""}
    ${glossary.length ? `<div class="sig-gloss">${glossary.map((g) => esc(g)).join("<br>")}</div>` : ""}
    ${factRows ? `<div class="jd-sec">Details</div><div class="jd-facts">${factRows}</div>` : ""}
    <div class="jd-sec">Attribution</div>
    <div class="jd-facts">
      <div class="jd-fact"><span class="jd-fk">Signal type</span><span class="jd-fv">${esc(s.type)}</span></div>
      <div class="jd-fact"><span class="jd-fk">Matched by</span><span class="jd-fv">${esc(basis === "name"
        ? "Company NAME, in a third-party source — verify it is really them"
        : "This company's own domain — DNS, their site, their job boards, their app/ad listings")}</span></div>
      <div class="jd-fact"><span class="jd-fk">Source</span><span class="jd-fv">${s.client ? "Watchlist · " + esc(s.client) : s.checkId ? "One-off check" : "—"}</span></div>
      <div class="jd-fact"><span class="jd-fk">When</span><span class="jd-fv">${esc(when)}</span></div>
      ${s.observedAt && s.observedAt !== s.createdAt ? `<div class="jd-fact"><span class="jd-fk">Recorded</span><span class="jd-fv">${esc(fmtTime(s.createdAt))}</span></div>` : ""}
    </div>
    ${grouped.length ? `<div class="jd-sec">Grouped with (${grouped.length})</div>
      <div class="sig-explain">Other reports of this kind for this company inside the grouping window. They are shown together to keep the feed short — they are not proof of each other.</div>
      <div class="jd-facts">${grouped.map((o) => {
        const ou = /^https?:\/\//i.test(String(o.url ?? "").trim()) ? String(o.url).trim() : "";
        return `<div class="jd-fact"><span class="jd-fk">${esc(fmtAgo(o.observedAt))}</span><span class="jd-fv">${
          ou ? `<a href="${esc(ou)}" target="_blank" rel="noopener">${esc(o.title)}</a>` : esc(o.title)}${sigBasisChip(o.type)}</span></div>`;
      }).join("")}</div>` : ""}`;
  const open = $("sigDOpen");
  // Validate before trusting: this URL is producer-supplied (a news item, an SEC filing, an ad
  // library page), and this was the one anchor in the app assigning .href with no scheme check —
  // javascript:, data: and vbscript: all reached it. Note it uses the same test as safeUrl() but
  // NOT safeUrl() itself: that HTML-escapes its result, which is right for markup and wrong for a
  // DOM property, where it would turn every "&" in a query string into "&amp;".
  const su = /^https?:\/\//i.test(String(s.url ?? "").trim()) ? String(s.url).trim() : "";
  if (su) { open.href = su; open.style.display = ""; } else open.style.display = "none";
  $("sigDDismiss").onclick = async () => {
    if (!await mutate(`/api/signals/${s.id}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, "Could not dismiss that signal")) return;
    closeSigDrawer(); loadSignals({ background: true });
    undismissToast(s.id);
  };
  openDrawer("sigBg", "sigDrawer", closeSigDrawer);
}
$("sigDCloseX") && ($("sigDCloseX").onclick = closeSigDrawer);
$("sigBg") && ($("sigBg").onclick = closeSigDrawer);
// Quick single-domain check (Checks tab): run every producer on one company on demand.
$("sigQuickBtn") && ($("sigQuickBtn").onclick = () => { const v = $("sigQuickDomain").value.trim(); if (v) openDomainCheck(v); });
$("sigQuickDomain") && $("sigQuickDomain").addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = e.target.value.trim(); if (v) openDomainCheck(v); } });

// On-demand per-company / single-domain signal check: runs every producer NOW, shows facts + a
// hit/no badge per signal, and persists flags + new signals (so the "Company signal" filters update).
// Fast on-demand set — excludes ads (real browser, ~40s) and subdomains (crt.sh, ~25s) so an inline
// check stays responsive; those two run in a full saved signal check (which streams progress).
const QUICK_CHECK_SIGNALS = ["velocity", "dns", "ats", "edgar", "warn", "apps", "ph", "news", "tech"];
async function openDomainCheck(domain) {
  domain = String(domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) return;
  const footer = $("sigDrawerFoot"); if (footer) footer.style.display = "none";
  $("sigDTitle").textContent = "Signal check";
  const skel = [0, 1, 2, 3].map(() => `<div class="scp-skel"></div>`).join("");
  $("sigDBody").innerHTML = `<div class="jd-head"><div class="sig-drawer-title">Checking ${esc(domain)}…</div>
    <div class="jd-co">Running every signal producer — this can take a moment</div></div><div class="sig-check-list">${skel}</div>`;
  openDrawer("sigBg", "sigDrawer", closeSigDrawer);
  let d;
  try { d = await (await fetch("/api/signals/check-domain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain, signals: QUICK_CHECK_SIGNALS }) })).json(); }
  catch { $("sigDBody").innerHTML = `<div class="jd-head"><div class="sig-drawer-title">Check failed</div></div><div class="sig-explain">Couldn't reach the server — try again.</div>`; return; }
  if (d.error) { $("sigDBody").innerHTML = `<div class="jd-head"><div class="sig-drawer-title">${esc(d.error)}</div></div>`; return; }
  const badge = (r) => r.error ? `<span class="scp-badge err">error</span>`
    : r.hit === true ? `<span class="scp-badge yes">yes</span>` : r.hit === false ? `<span class="scp-badge no">no</span>` : `<span class="scp-badge na">—</span>`;
  const rows = (d.results || []).map((r) => {
    const facts = Object.entries(r.facts || {}).filter(([, v]) => typeof v !== "object").map(([k, v]) => `<div class="jd-fact"><span class="jd-fk">${esc(k)}</span><span class="jd-fv">${linkifyFact(v)}</span></div>`).join("");
    return `<div class="scp"><div class="scp-head"><span class="scp-label">${esc(r.label)}</span>${badge(r)}</div>
      ${r.summary ? `<div class="scp-sum">${esc(r.summary)}</div>` : ""}
      ${r.error ? `<div class="scp-err">${esc(r.error)}</div>` : facts ? `<div class="jd-facts">${facts}</div>` : ""}</div>`;
  }).join("");
  $("sigDBody").innerHTML = `<div class="jd-head"><div class="sig-drawer-title">${esc(d.domain)}</div>
    <div class="jd-co">${d.company ? esc(d.company) + " · " : ""}<a href="https://${esc(d.domain)}" target="_blank" rel="noopener">${esc(d.domain)}</a></div></div>
    <div class="sig-explain">Live check across every signal producer. Results are saved and now power the "Company signal" filters.</div>
    <div class="sig-check-list">${rows}</div>`;
  if (sigTab === "feed" && state.view === "signals") loadSignals({ background: true }); // surface new signals without blanking the feed
}

function sigRenderScanBtn() {
  // "Scan now" only makes sense for ONE monitor that actually has signal types enabled.
  const c = CONFIGS.find((x) => x.name === sigState.client);
  $("sigScanBtn").style.display = (c && c.signalsEnabled) ? "" : "none";
}
async function loadSignalsView() {
  await ensureTaxonomy();                  // labels/categories drive the filters built below
  if (!CONFIGS.length) await loadConfig(); // booting straight into this view (persisted tab)
  // Monitor dropdown: every configured monitor (signals are attributed to the watchlist that found them).
  const sel = $("sigClient");
  sel.innerHTML = '<option value="">All monitors</option>'
    + CONFIGS.map((c) => `<option value="${esc(c.name)}">${(c.kind === "watchlist" ? "[Account] " : "[Client] ") + esc(c.name)}</option>`).join("");
  sel.value = sigState.client;
  if (sel.value !== sigState.client) { sigState.client = ""; sel.value = ""; } // monitor was deleted
  sigRenderScanBtn();
  if (!sigWired) {
    sigWired = true;
    sel.onchange = () => { sigState.client = sel.value; sigState.offset = 0; sigRenderScanBtn(); loadSignals(); };
    // CATEGORY is the primary filter — "Funding" means a raise however we found it (US filing, UK
    // filing, English press, foreign press). The Signal-type multiselect below stays as the
    // narrower sub-filter for when the exact source matters.
    buildMultiselect("msSigCatPanel", "msSigCatBtn", SIGNAL_CATEGORIES.map((c) => [c.key, c.label]), sigState.catSel, "Category", () => {
      $("msSigCatBtn").innerHTML = `Category: ${sigState.catSel.length ? sigState.catSel.length + " selected" : "any"} <span class="caret">${icon('chevron')}</span>`;
      sigState.offset = 0; loadSignals();
    });
    buildMultiselect("msSigTypePanel", "msSigTypeBtn", SIGNAL_TYPES, sigState.typeSel, "Signal", () => {
      $("msSigTypeBtn").innerHTML = `Signal: ${sigState.typeSel.length ? sigState.typeSel.length + " selected" : "any"} <span class="caret">${icon('chevron')}</span>`;
      sigState.offset = 0; loadSignals();
    });
    // Grouping is a DISPLAY choice — webhooks always deliver every signal individually.
    // The stats must re-read too — they are scoped by the same toggle.
    $("sigGroup").onchange = () => { sigState.group = $("sigGroup").checked; sigState.offset = 0; loadSignals(); loadSignalStats(); };
    // Export + copy: the feed is the daily working surface and had no way out of it but opening
    // rows one at a time. Both cover the CURRENT filter and grouping, not just the visible page.
    $("sigExport").onclick = () => window.open("/api/signals/export?" + sigFilterParams(), "_blank");
    $("sigCopy").onclick = async () => {
      const btn = $("sigCopy");
      setBtnLoading("sigCopy", true, "Copying…");
      try {
        const text = await (await fetch("/api/signals/export?" + sigFilterParams())).text();
        await navigator.clipboard.writeText(text);
        const rows = Math.max(0, text.trim().split("\n").length - 1);
        toast(`Copied ${fmtNum(rows)} signal${rows === 1 ? "" : "s"} to the clipboard`);
      } catch (e) { toast("Couldn't copy — " + (e?.message || "clipboard unavailable"), true); }
      finally { setBtnLoading("sigCopy", false); btn.textContent = "Copy"; }
    };
    let sq; $("sigQ").oninput = () => { clearTimeout(sq); sq = setTimeout(() => { sigState.q = $("sigQ").value.trim(); sigState.offset = 0; loadSignals(); }, 250); };
    // "When" range → the earliest event date to include (event date = observed_at, else created_at).
    $("sigWhen").onchange = () => {
      const days = Number($("sigWhen").value) || 0;
      sigState.since = days ? new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10) : "";
      sigState.offset = 0; loadSignals();
    };
    // "All history" → include dismissed signals so nothing is lost from the record once handled.
    $("sigHistory").onchange = () => { sigState.history = $("sigHistory").checked; sigState.offset = 0; loadSignals(); };
    $("sigPrev").onclick = () => { sigState.offset = Math.max(0, sigState.offset - sigState.limit); loadSignals(); };
    $("sigNext").onclick = () => { sigState.offset += sigState.limit; loadSignals(); };
    $("sigScanBtn").onclick = async () => {
      setBtnLoading("sigScanBtn", true, "Scanning…");
      try {
        const r = await fetch("/api/signals/run/" + encodeURIComponent(sigState.client), { method: "POST" });
        const d = await r.json();
        if (!r.ok) toast(d.error || "Couldn't start the scan", true);
        else { toast("Scanning — new signals will appear shortly"); setTimeout(loadSignals, 2500); }
      } catch { toast("Couldn't start the scan", true); }
      finally { setBtnLoading("sigScanBtn", false); }
    };
  }
  loadSignals();
}

// ---- Signals → Checks sub-tab: one-off multi-signal checks on an uploaded domain list ----
let sigTab = "feed", scScreen = "list", scId = null, scEs = null, scSnapshot = null;
function sigShowTab(tab) {
  if (tab !== "sigco") bulkExit();       // leaving the Companies sub-tab drops any bulk selection
  sigTab = tab;
  const sel = $("sigTabSel"); if (sel && sel.value !== tab) sel.value = tab;
  $("sigFeedControls").style.display = tab === "feed" ? "contents" : "none"; // hide feed filters off the Feed
  $("sigTabFeed").style.display = tab === "feed" ? "" : "none";
  $("sigTabChecks").style.display = tab === "checks" ? "" : "none";
  $("sigTabCompanies").style.display = tab === "sigco" ? "" : "none";
  // Close the check's live stream whenever we leave that sub-tab, not only when we arrive at it —
  // switching Checks → Feed used to leave the EventSource open and receiving for a detail screen
  // that is no longer on the page.
  scCloseStream();
  if (tab === "checks") { scShow("list"); scLoadList(); }
  if (tab === "sigco") { sigcoState.offset = 0; loadSigCompanies(); }
  syncHash();
}
$("sigTabSel").onchange = () => sigShowTab($("sigTabSel").value);
function scShow(screen) {
  scScreen = screen;
  $("scScreenList").style.display = screen === "list" ? "" : "none";
  $("scScreenNew").style.display = screen === "new" ? "" : "none";
  $("scScreenDetail").style.display = screen === "detail" ? "" : "none";
}
const scCloseStream = () => { if (scEs) { scEs.close(); scEs = null; } };

async function scLoadList() {
  const q = $("scSearch").value.trim();
  const tok = loadToken("scList");   // the search box debounces, but two keystrokes can still race
  let items = [];
  try { items = (await fjson("/api/signal-checks" + (q ? "?q=" + encodeURIComponent(q) : ""))).items || []; }
  catch { $("scSavedList").innerHTML = `<div class="ac-empty">${BUSY_MSG}</div>`; retrySoon("scList", scLoadList); return; }
  if (loadStale("scList", tok)) return;
  $("scSavedList").innerHTML = items.length ? items.map((s) => {
    const pct = s.total ? Math.round((s.checked / s.total) * 100) : 0;
    const chip = s.status === "running" ? '<span class="ac-chip run" style="background:var(--accent-soft);color:var(--accent)">running</span>'
      : s.status === "done" ? '<span class="ac-chip" style="background:var(--good-soft);color:var(--good)">done</span>'
      : s.status === "error" ? '<span class="ac-chip" style="background:var(--danger-soft);color:var(--danger)">error</span>'
      : `<span class="ac-chip" style="background:var(--line2);color:var(--muted)">${esc(s.status)}</span>`;
    return `<div class="ac-row" data-id="${esc(s.id)}">
      <div class="ac-row-main">
        <div class="ac-row-name">${esc(s.name)}</div>
        <div class="ac-row-sub">${chip}<span>${fmtNum(s.checked)}/${fmtNum(s.total)} domains</span><span>${fmtNum(s.totalHits)} signal${s.totalHits === 1 ? "" : "s"}</span><span class="ac-ago">${fmtTime(s.createdAt)}</span></div>
        ${s.status === "running" ? `<div class="ac-mini-bar"><div style="width:${pct}%"></div></div>` : ""}
      </div>
      <button class="ac-row-del" data-del="${esc(s.id)}" data-tip="Delete" aria-label="Delete">&times;</button>
    </div>`;
  }).join("") : '<div class="ac-empty">No signal checks yet. Run your first with “+ New signal check”.</div>';
  $("scSavedList").querySelectorAll(".ac-row").forEach((r) => rowActivate(r, () => scOpenDetail(r.dataset.id)));
  $("scSavedList").querySelectorAll("[data-del]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    if (!await uiConfirm("Delete this signal check and its recorded signals?", { title: "Delete signal check", confirmLabel: "Delete", danger: true })) return;
    if (!await mutate("/api/signal-checks/" + encodeURIComponent(b.dataset.del), { method: "DELETE" }, "Could not delete that check")) return;
    scLoadList();
  });
}
let scSearchT; $("scSearch").oninput = () => { clearTimeout(scSearchT); scSearchT = setTimeout(scLoadList, 250); };

// New-check screen: domains textarea + CSV upload (same auto-pick as the watchlist editor) + producer checkboxes
function scUpdateCount() {
  const n = wlSplitDomains($("scDomains").value).length;
  $("scCount").textContent = n ? `${n} domain${n === 1 ? "" : "s"} to check` : "No domains yet";
}
$("scDomains").oninput = scUpdateCount;
// Shared upload dropzone: default markup (icon + drag copy), a "file chosen" state, and drag-and-drop.
const DROP_ICON = '<svg class="ac-drop-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';
const dropDefaultHtml = (note) => `${DROP_ICON}<div class="ac-drop-txt"><b>Drop a CSV here</b> or click to browse<span class="rnote">${note}</span></div>`;
const dropChosenHtml = (name, detail) => `${DROP_ICON}<div class="ac-drop-txt"><b>${esc(name)}</b> — ${detail}<span class="rnote">click or drop to replace</span></div>`;
function wireDrop(dropId, fileId) {
  const drop = $(dropId), file = $(fileId);
  drop.onclick = () => file.click();
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "dragend"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("dragover")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0]; if (!f) return;
    const dt = new DataTransfer(); dt.items.add(f); file.files = dt.files;
    file.dispatchEvent(new Event("change")); // reuse the existing file-select handler
  });
}
wireDrop("scDrop", "scFile");
$("scFile").onchange = async () => {
  const f = $("scFile").files[0]; if (!f) return;
  const rows = acParseCSV(await f.text());
  if (!rows.length) return;
  const ncol = Math.max(...rows.map((r) => r.length));
  const head = rows[0].map((c) => /domain|website|\burl\b|site/i.test(c || ""));
  let col = head.findIndex(Boolean);
  const looksHeader = col >= 0;
  if (col < 0) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < ncol; i++) {
      const score = rows.reduce((a, r) => a + (/^[^@\s]+\.[a-z]{2,}/i.test((r[i] || "").trim()) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    col = best;
  }
  const cells = (looksHeader ? rows.slice(1) : rows).map((r) => r[col] || "");
  const domains = wlSplitDomains(cells.join("\n"));
  $("scDomains").value = domains.join("\n");
  $("scDrop").innerHTML = dropChosenHtml(f.name, `${domains.length} domain${domains.length === 1 ? "" : "s"}`);
  scUpdateCount();
};
async function scOpenNew() {
  $("scName").value = ""; $("scDomains").value = ""; $("scMsg").textContent = "";
  // The webhook was the ONE field this reset missed. #scWebhook is a persistent static input and
  // scShow() only toggles display, so the previous check's URL survived — and the next run happily
  // POSTed its signals to a Slack channel or CRM the user had not chosen for it.
  $("scWebhook").value = "";
  $("scDrop").innerHTML = dropDefaultHtml('we auto-pick the domain/website column');
  scUpdateCount();
  // Reveal the screen BEFORE the network round-trips, the way scOpenDetail already does. Awaiting
  // first meant "+ New signal check" looked dead until both requests resolved, so it got clicked
  // again — firing duplicate work at an already-busy single-threaded server.
  scShow("new");
  // Ask whether a Companies House key exists, so its checkbox can default off when it cannot run.
  // Failing soft to "a key is set" keeps the old behaviour if /api/settings is unreachable.
  const [items, regions, chSet] = await Promise.all([
    sigProducers(), adRegions(),
    fetch("/api/settings").then((r) => r.json()).then((s) => !!s.companiesHouseKeySet).catch(() => true),
  ]);
  // items is NULL when the catalogue could not be fetched — the same three-outcome contract
  // renderSignalPicker and bulkRun follow. Reading .length on it threw a TypeError mid-render and left
  // the drawer half-built with an unusable Run button. (Introduced when sigProducers gained its null
  // sentinel and this third caller was missed.)
  if (!items) {
    $("scSignals").innerHTML = '<span class="hint">Couldn’t load the signal types — the engine may be busy. <button type="button" class="lnk" data-sc-retry>Try again</button></span>';
    const rb = $("scSignals").querySelector("[data-sc-retry]");
    if (rb) rb.onclick = () => { SIG_PRODUCERS = null; scOpenNew(); };
    return;
  }
  $("scSignals").innerHTML = items.length
    // Companies House needs an API key. Pre-ticking it with no key saved means every run spends a
    // whole grid column on "no API key — add one in Settings" for every domain. Off by default
    // until a key exists, and the label says why rather than leaving a dead checkbox unexplained.
    ? items.map((p) => {
        const needsKey = p.key === "companieshouse" && !chSet;
        return `<label data-tip="${esc(needsKey ? p.description + " — needs a free API key, add one in Settings." : p.description)}">`
          + `<input type="checkbox" data-sig="${esc(p.key)}" ${needsKey ? "" : "checked"}/> ${esc(p.label)}`
          + `${needsKey ? ' <span class="meta">(needs a key)</span>' : ""}</label>`;
      }).join("")
    : '<span class="hint">No signal types available.</span>';
  // The ad region belongs next to the signal it changes, not in Settings — it's a per-run choice
  // ("check these UK accounts for UK ads"). Shown only while "Meta ad activity" is ticked; starts
  // from the saved Settings default, and leaving it alone changes nothing.
  const adRow = $("scAdRegion");
  if (adRow) {
    const hasAds = items.some((p) => p.key === "ads");
    adRow.innerHTML = hasAds
      ? `<label for="scAdCountry">Look for ads in
           <button type="button" class="tip" aria-label="More information" data-tip="Which region of the Meta Ad Library to search for THIS check. Worldwide finds ads wherever they run. Pick one country and a company with no ads there is reported as 'not checked elsewhere' rather than 'no ads' — we can't see the rest of the world. This choice applies to this check only; the default lives in Settings.">i</button>
         </label>
         <select id="scAdCountry">${adRegionOptions(regions.default || "ALL")}</select>`
      : "";
    scSyncAdRegion();
  }
}
/** Show the ad-region row only when the Meta-ads producer is actually selected. */
function scSyncAdRegion() {
  const row = $("scAdRegion"); if (!row || !row.firstChild) return;
  const on = !!document.querySelector('#scSignals input[data-sig="ads"]:checked');
  row.style.display = on ? "" : "none";
}
$("scSignals")?.addEventListener("change", (e) => { if (e.target?.dataset?.sig === "ads") scSyncAdRegion(); });
$("scNewBtn").onclick = scOpenNew;
$("scNewBack").onclick = () => { scShow("list"); scLoadList(); };
$("scRun").onclick = async () => {
  const domains = wlSplitDomains($("scDomains").value);
  const signals = [...document.querySelectorAll('#scSignals input[data-sig]:checked')].map((i) => i.dataset.sig);
  const msg = (t, err) => { $("scMsg").textContent = t; $("scMsg").className = "msg " + (err ? "err" : "ok"); };
  if (!domains.length) return msg("Add at least one domain", true);
  if (!signals.length) return msg("Pick at least one signal type", true);
  // A signal check runs EVERY selected producer against EVERY domain — strictly more work per
  // domain than an account check, which sits beside it and has warned about size since it shipped.
  // Same shape of estimate, from the same kind of arithmetic: 6 domains in flight at once, and a
  // domain costs roughly 4s per producer (network-bound; each producer bounds its own concurrency).
  const nDom = domains.length, SC_CONCURRENCY = 6, PER_PRODUCER_SECS = 4;
  const secs = Math.ceil(nDom / SC_CONCURRENCY) * signals.length * PER_PRODUCER_SECS;
  const estimate = secs <= 90 ? `under ${Math.ceil(secs / 30) * 30} seconds`
    : secs < 5400 ? `roughly ${Math.max(1, Math.round(secs / 60))} min`
    : `roughly ${(secs / 3600).toFixed(1)} hours`;
  if (nDom > 25) {
    const warn = `Checking ${fmtNum(nDom)} domain${nDom === 1 ? "" : "s"} against ${signals.length} signal type${signals.length === 1 ? "" : "s"} — ${estimate}.`
      + ` That is ${fmtNum(nDom * signals.length)} lookups. It runs in the background — you can close this and come back to it.`;
    if (!await uiConfirm(warn + "\n\nStart?", { title: "Large signal check", confirmLabel: "Start" })) return;
  }
  setBtnLoading("scRun", true, "Starting…");
  try {
    const res = await fetch("/api/signal-checks", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("scName").value.trim(), domains, signals, webhook: ($("scWebhook")?.value || "").trim(),
        adCountry: signals.includes("ads") ? ($("scAdCountry")?.value || "") : "" }) });
    const d = await res.json();
    if (!res.ok) return msg(d.error || "Couldn't start", true);
    toast(capNote(d) || `Checking ${fmtNum(d.count)} domain${d.count === 1 ? "" : "s"} for ${signals.length} signal type${signals.length === 1 ? "" : "s"}…`, !!d.capped);
    scOpenDetail(d.id);
  } catch (e) { msg("Couldn't start: " + e.message, true); }
  finally { setBtnLoading("scRun", false); }
};

// Detail screen: snapshot + live SSE tail → the domain × signal facts grid
function scRenderDetail(s) {
  scSnapshot = s;
  $("scDName").textContent = s.name;
  const st = s.status === "running" ? "Running…" : s.status === "done" ? "Completed" : s.status[0].toUpperCase() + s.status.slice(1);
  $("scDStatus").innerHTML = `<span class="hint">${esc(st)} · ${fmtNum(s.checked)}/${fmtNum(s.total)} domains · ${fmtNum(s.totalHits)} signal${s.totalHits === 1 ? "" : "s"}</span>`;
  $("scStop").style.display = s.status === "running" ? "" : "none";
  $("scDownload").style.display = (s.results || []).length ? "" : "none";
  const keys = (s.params?.signals) || [];
  // The ad region is part of what a result MEANS ("no ads" in Germany ≠ "no ads"), so it's shown
  // beside the run's other parameters rather than left implicit.
  const adCc = keys.includes("ads") ? (s.params?.adCountry || "") : "";
  $("scParams").innerHTML = [
    `<span class="ac-pchip"><b>${fmtNum((s.params?.domains || []).length)}</b> domains submitted</span>`,
    `<span class="ac-pchip">Signals: <b>${esc(keys.join(", ") || "—")}</b></span>`,
    adCc ? `<span class="ac-pchip">Ads region: <b>${esc(adRegionLabel(adCc))}</b></span>` : "",
    `<span class="ac-pchip">Created <b>${fmtTime(s.createdAt)}</b></span>`,
  ].filter(Boolean).join("");
  const running = s.status === "running";
  $("scProgWrap").style.display = running ? "block" : "none";
  if (running) {
    const pct = s.total ? Math.round((s.checked / s.total) * 100) : 0;
    $("scStatus").textContent = "Checking…"; $("scNums").textContent = `${fmtNum(s.checked)}/${fmtNum(s.total)}`;
    $("scBar").style.width = pct + "%";
  }
  scRenderGrid(s);
}
// What each check column means, where the data comes from, and its scope — the header's hover help.
const PRODUCER_EXPLAIN = {
  velocity: "Hiring pace. Source: the job postings this app already collects for the company. Scope: roles we track — a surge, a new location, or chronic reposts.",
  dns: "Email setup. Source: the domain's public DNS records (MX + SPF), read live. Scope: which email provider they use and which sending tools are authorized to send as them.",
  ats: "Hiring tools. Source: live probes of public Greenhouse / Lever / Ashby job boards. Scope: which applicant-tracking system the company runs right now.",
  tech: "Website tech. Source: the company's own homepage, fingerprinted live (webappanalyzer patterns in script tags, headers and meta tags). Scope: tools running on their site right now, and anything added or removed since the last scan. NOT the same as the Technologies page — that one reads job-ad text, this one reads their website.",
  subdomains: "Web presence. Source: public certificate-transparency logs (new SSL certs). Scope: new subdomains like app. / shop. / docs. — often a new product surface.",
  edgar: "US filings. Source: SEC EDGAR full-text search. Scope: US-registered filers only — Form D (raised private money), 8-K (major event), S-1 (IPO prep).",
  companieshouse: "UK filings. Source: the official Companies House API (needs the free key in Settings). Scope: UK-registered companies — SH01 share allotments, the UK fundraise proxy.",
  apps: "Mobile apps. Source: Apple App Store / Google Play lookups by company name. Scope: whether they ship apps and how fresh the iOS app is.",
  news: "Company news. Source: Google News (US, UK, India, Australia editions), last 45 days. Scope: headlines mentioning the company, classified into funding / leadership / layoffs / expansion / partnership / launch.",
  gdelt: "Global funding news. Source: the GDELT worldwide news index (100+ languages), last 45 days. Scope: funding-related headlines — catches regional and non-English press. SLOW BY DESIGN: GDELT allows about one lookup every 5 seconds, so companies are queued one at a time. On a large watchlist expect it to reach only part of the list per run, and to be the slowest thing in the scan.",
  warn: "Layoffs. Source: official state WARN filings (43 states + DC, plus NY's own list). Scope: US employers only — the advance notice required before large layoffs.",
  ph: "Product Hunt. Source: the Product Hunt launch feed. Scope: launches matching the company name — launch/growth mode.",
  ads: "Meta ads. Source: Meta's public Ad Library page (US). Scope: whether the company is running Facebook/Instagram ads right now.",
};
// Escape a fact value, then turn any URL in it into a small "open" link (used by grid + drawer).
const linkifyFact = (v) => esc(String(v)).replace(/(https?:\/\/[^\s<]+)/g, '<a class="sc-link" href="$1" target="_blank" rel="noopener">open ↗</a>');

// Results are paginated like every other table (15/page). Page state lives here and resets when a
// detail opens; a running check streams new rows into the TOTAL while the user's page stays put.
const SC_PAGE_SIZE = 15;
// Most domains one monitor may watch. The authority is DOMAIN_CAP in src/config.ts, which rejects an
// over-limit save whatever sent it (browser, API, or a hand-edited YAML file). This copy exists so the
// editor can say so BEFORE the save, and src/uiHonesty.test.ts fails if the two ever drift apart.
const DOMAIN_CAP = 10000;
let scGridPage = 0;
// Client-side because the whole result set is already in scSnapshot.results — a check is bounded by
// the domain list the user uploaded, so there is nothing to page in from the server.
const scGrid = { sort: "signals", dir: "desc", q: "", has: "" };
const scExpanded = new Set();   // domains the user has opened, preserved across live re-renders
// Per-producer sort value for one row. A producer column has no single number, so it sorts by how
// much it actually found: a real hit (facts present) outranks a miss, and a miss outranks a producer
// that errored or never ran. Ties fall through to the domain so the order is stable.
const scCellRank = (r, k) => {
  const f = r.facts?.[k];
  const n = f ? Object.keys(f).length : 0;
  if (n) return 1000 + n;
  return (r.errors || []).some((e) => String(e).startsWith(k + ":")) ? -1 : 0;
};
function scVisibleRows(all) {
  const q = scGrid.q.trim().toLowerCase();
  let rows = all.filter((r) => {
    if (scGrid.has === "yes" && !(r.signals > 0)) return false;
    if (scGrid.has === "no" && r.signals > 0) return false;
    if (scGrid.has === "err" && !(r.errors || []).length) return false;
    if (!q) return true;
    return String(r.domain || "").toLowerCase().includes(q)
      || String(r.facts?.company?.["Resolved name"] || "").toLowerCase().includes(q);
  });
  const s = scGrid.sort, mul = scGrid.dir === "asc" ? 1 : -1;
  const dom = (r) => String(r.domain || "");
  rows = rows.slice().sort((a, b) => {
    let d = 0;
    if (s === "domain") d = dom(a).localeCompare(dom(b));
    else if (s === "signals") d = (a.signals || 0) - (b.signals || 0);
    else d = scCellRank(a, s) - scCellRank(b, s);
    return d ? d * mul : dom(a).localeCompare(dom(b));  // stable tiebreak, direction-independent
  });
  return rows;
}
function scRenderGrid(s) {
  const keys = (s.params?.signals) || [];
  const prods = SIG_PRODUCERS || [];
  const label = (k) => (prods.find((p) => p.key === k) || { label: k }).label;
  $("scHead").innerHTML = `<tr><th data-scsort="domain" data-tip="The company website that was checked. Click a row to expand its full results. Click this header to sort.">Domain</th>${keys.map((k) => `<th data-scsort="${esc(k)}" data-tip="${esc((PRODUCER_EXPLAIN[k] || "") + " · Sorting puts the domains where this found something first.")}">${esc(label(k))}</th>`).join("")}<th style="width:70px" data-scsort="signals" data-tip="How many feed signals this check recorded for the domain — they also went to the check's webhook, if one was set. Sorted highest-first by default.">Signals</th></tr>`;
  const all = s.results || [];
  const shown = scVisibleRows(all);
  const totalPages = Math.max(1, Math.ceil(shown.length / SC_PAGE_SIZE));
  if (scGridPage >= totalPages) scGridPage = totalPages - 1;
  const start = scGridPage * SC_PAGE_SIZE;
  const rows = shown.slice(start, start + SC_PAGE_SIZE);
  const filtered = shown.length !== all.length;
  // Say what was filtered OUT. A count that silently shrinks reads as "the check found less".
  $("scSummary").textContent = !all.length ? ""
    : filtered ? `${fmtNum(shown.length)} of ${fmtNum(all.length)} domain${all.length === 1 ? "" : "s"} shown`
    : `${fmtNum(all.length)} domain${all.length === 1 ? "" : "s"} checked`;
  $("scPageInfo").textContent = shown.length ? `Showing ${fmtNum(start + 1)}–${fmtNum(start + rows.length)} of ${fmtNum(shown.length)}` : "";
  $("scPageNum").textContent = `Page ${scGridPage + 1} of ${totalPages}`;
  $("scPagePrev").disabled = scGridPage === 0;
  $("scPageNext").disabled = scGridPage >= totalPages - 1;
  $("scBody").innerHTML = rows.length ? rows.map((r) => `
    <tr class="sc-xrow collapsed" data-x data-tip="Click to expand or collapse this row's full results">
      <td style="white-space:nowrap"><span class="sc-caret">${icon("chevron")}</span><b>${esc(r.domain)}</b>${r.facts?.company?.["Resolved name"] ? `<div class="sc-fact"><span>${esc(r.facts.company["Resolved name"])}</span></div>` : ""}${r.errors?.length ? ` <button type="button" class="tip" aria-label="More information" data-tip="${esc(r.errors.join("; "))}">!</button>` : ""}</td>
      ${keys.map((k) => {
        const f = r.facts?.[k];
        const entries = f ? Object.entries(f) : [];
        const more = entries.length > 2 ? `<div class="sc-more">+${entries.length - 2} more…</div>` : "";
        return `<td>${entries.length ? entries.map(([kk, vv]) => `<div class="sc-fact"><span>${esc(kk)}:</span> <b>${linkifyFact(vv)}</b></div>`).join("") + more : '<span style="color:var(--faint)">—</span>'}</td>`;
      }).join("")}
      <td>${r.signals ? `<span class="sig-pill" style="background:var(--accent)">${r.signals}</span>` : '<span style="color:var(--faint)">0</span>'}</td>
    </tr>`).join("") : `<tr class="none"><td colspan="${keys.length + 2}">${
      filtered ? "No domain matches this filter. Clear it to see all " + fmtNum(all.length) + "."
      : s.status === "running" ? "Results build here as domains complete…" : "No results."}</td></tr>`;
  // Whole row toggles expanded/collapsed (links inside stay clickable).
  // Restore whatever the user had expanded. Every SSE progress tick rebuilds this table via
  // innerHTML, so a row opened while a check was still running snapped shut a second later —
  // during the exact operation you would be reading it. Keyed by domain, not row index, so it
  // survives the rows moving as the sort or filter changes.
  $("scBody").querySelectorAll("tr[data-x]").forEach((tr) => {
    const dom = tr.querySelector("b")?.textContent || "";
    if (scExpanded.has(dom)) tr.classList.remove("collapsed");
    rowActivate(tr, () => {
      tr.classList.toggle("collapsed");
      if (tr.classList.contains("collapsed")) scExpanded.delete(dom); else scExpanded.add(dom);
    });
  });
  // Same shared helper every other sortable table uses, so these headers get the caret, aria-sort,
  // focusability and Enter/Space activation for free.
  wireSortHeaders("#scHead", "data-scsort", () => scGrid.sort, () => scGrid.dir, (k, d) => {
    scGrid.sort = k; scGrid.dir = d; scGridPage = 0; if (scSnapshot) scRenderGrid(scSnapshot);
  });
}
// Filter controls. Every change resets to page 1 — otherwise a filter applied on page 4 lands on an
// empty page and reads as "no results".
const scFilterChanged = () => { scGridPage = 0; if (scSnapshot) scRenderGrid(scSnapshot); };
let scQTimer; $("scFilterQ").oninput = () => { clearTimeout(scQTimer); scQTimer = setTimeout(() => { scGrid.q = $("scFilterQ").value; scFilterChanged(); }, 200); };
$("scFilterHas").onchange = () => { scGrid.has = $("scFilterHas").value; scFilterChanged(); };
$("scFilterClear").onclick = () => {
  scGrid.q = ""; scGrid.has = "";
  $("scFilterQ").value = ""; $("scFilterHas").value = "";
  scFilterChanged();
};
$("acPagePrev") && ($("acPagePrev").onclick = () => { acOffset = Math.max(0, acOffset - AC_PAGE); acRenderResults(); acScrollTop(); });
$("acPageNext") && ($("acPageNext").onclick = () => { acOffset += AC_PAGE; acRenderResults(); acScrollTop(); });
$("scPagePrev").onclick = () => { if (scGridPage > 0) { scGridPage--; if (scSnapshot) scRenderGrid(scSnapshot); } };
$("scPageNext").onclick = () => { scGridPage++; if (scSnapshot) scRenderGrid(scSnapshot); };
async function scOpenDetail(id) {
  scCloseStream();
  scGridPage = 0; // fresh detail starts on page 1
  // …and on an unfiltered, default-sorted grid. Carrying the last check's filter over made a new
  // check look like it had found nothing.
  scGrid.sort = "signals"; scGrid.dir = "desc"; scGrid.q = ""; scGrid.has = "";
  scExpanded.clear();
  $("scFilterQ").value = ""; $("scFilterHas").value = "";
  scId = id; scShow("detail");
  await Promise.all([sigProducers(), adRegions()]); // grid column labels + the ads-region chip label
  scEs = new EventSource("/api/signal-checks/" + encodeURIComponent(id) + "/stream");
  scEs.addEventListener("snapshot", (e) => scRenderDetail(JSON.parse(e.data)));
  scEs.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    if (!scSnapshot) return;
    scSnapshot.checked = p.checked; scSnapshot.found = p.found; scSnapshot.totalHits = p.totalHits;
    scSnapshot.results = [...(scSnapshot.results || []), ...(p.newResults || [])];
    scRenderDetail(scSnapshot);
  });
  scEs.addEventListener("done", async (e) => {
    scCloseStream();
    const d = JSON.parse(e.data);
    if (scSnapshot) { scSnapshot.status = d.status || "done"; scRenderDetail(scSnapshot); }
    if ((d.status || "done") === "done") toast("Signal check complete");
  });
  scEs.addEventListener("error", () => { /* stream hiccup — snapshot already rendered */ });
}
$("scDetailBack").onclick = () => { scCloseStream(); scShow("list"); scLoadList(); };
$("scStop").onclick = async () => {
  if (!scId) return;
  // mutate() returns null and has ALREADY shown the error toast when the call failed. This was the
  // one call site that ignored that, so a failed stop showed "Could not stop the check" immediately
  // followed by "Stopping…" — two contradictory toasts, and the user believed the second.
  const r = await mutate("/api/signal-checks/" + encodeURIComponent(scId) + "/stop", { method: "POST" }, "Could not stop the check");
  if (r) toast("Stopping — in-flight domains finish first");
};
$("scDownload").onclick = () => { if (scId) window.open("/api/signal-checks/" + encodeURIComponent(scId) + "/export", "_blank"); };
$("scDelete").onclick = async () => {
  if (!scId) return;
  if (!await uiConfirm("Delete this signal check and its recorded signals?", { title: "Delete signal check", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/signal-checks/" + encodeURIComponent(scId), { method: "DELETE" }, "Could not delete that check")) return;
  scCloseStream(); scShow("list"); scLoadList();
};

// ---- Companies view (hiring-signal rollup + score + GTM export) ----
let coState = { sort: "score", dir: "desc", offset: 0, limit: 15, total: 0 };
function postTabHtml(tab) {
  const showCo = tab === "companies";
  $("tblScroll").style.display = showCo ? "none" : "";
  $("coScroll").style.display = showCo ? "" : "none";
  $("coBulk").style.display = showCo ? "" : "none";
  $("coResolve").style.display = showCo ? "" : "none";
  $("coExport").style.display = showCo ? "" : "none";
  $("coCopy").style.display = showCo ? "" : "none";
  if (!showCo) bulkExit(); // leaving the Companies sub-tab drops any bulk selection
  // postings-only actions hide in companies mode
  for (const id of ["verifyBtn", "dedupeBtn", "poExport", "poCopy"]) $(id).style.display = showCo ? "none" : "";
  // Roving tabindex + aria-selected: the tab role promises exactly one stop in the Tab order and
  // arrow keys between the tabs, and neither existed.
  $("postSeg").querySelectorAll("[role=tab]").forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
}
const postTabs = [...$("postSeg").querySelectorAll("[role=tab]")];
const postTabGo = (b) => {
  state.postTab = b.dataset.tab; postTabHtml(state.postTab);
  if (state.postTab === "companies") { coState.offset = 0; loadCompanies(); } else loadMatches();
};
postTabs.forEach((b, i) => {
  b.onclick = () => postTabGo(b);
  b.onkeydown = (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? postTabs.length - 1 - i : 0;
    if (!d) return;
    e.preventDefault();
    const next = postTabs[(i + d + postTabs.length) % postTabs.length];
    postTabGo(next); next.focus();
  };
});

// Optional "Top hiring companies" side panel — OFF by default (it ate horizontal space); preference persists.
// Data is already fetched by loadStats(), so showing/hiding is pure layout — no extra request.
const CO_SIDE_KEY = "se_coside";
function applyCoSidebar() {
  const on = localStorage.getItem(CO_SIDE_KEY) === "1";
  $("monLayout")?.classList.toggle("no-side", !on);
  const btn = $("coSideToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const lbl = $("coSideToggleLbl"); if (lbl) lbl.textContent = on ? "Hide companies" : "Companies panel";
  }
}
$("coSideToggle").onclick = () => {
  localStorage.setItem(CO_SIDE_KEY, localStorage.getItem(CO_SIDE_KEY) === "1" ? "0" : "1");
  applyCoSidebar();
};
applyCoSidebar();
function coScopeParams() {
  const p = new URLSearchParams();
  if (state.client) p.set("client", state.client); else p.set("kind", state.kind);
  if (state.signalSel.length) p.set("signals", state.signalSel.join(",")); // shared "Company signal" filter
  p.set("sort", coState.sort); p.set("dir", coState.dir);
  return p;
}
async function loadCompanies(opts) {
  const tok = loadToken("companies");
  maybeSkeleton(opts, "coRows", 7, coState.limit);
  const p = coScopeParams(); p.set("limit", coState.limit); p.set("offset", coState.offset);
  let d; try { d = await fjson("/api/companies?" + p); }
  catch {
    if (loadStale("companies", tok)) return;
    $("coRows").innerHTML = `<tr><td colspan="7" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("companies", loadCompanies); return;
  }
  if (loadStale("companies", tok)) return;
  coState.total = d.total;
  renderMatchEmpty(d.items.length, "coEmpty", "No companies in this view yet.");
  $("coRows").innerHTML = d.items.map((c, i) => {
    const domain = String(c.domains || "").split(",").filter(Boolean)[0] || "";
    const isAuto = c.domainSource === "auto";
    const monitors = String(c.monitors || "").split(",").filter(Boolean);
    const heat = Number(c.score) >= 15 ? "hot" : Number(c.score) >= 6 ? "warm" : "cool";
    const domCell = domain
      ? `<a class="dom" href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)}</a>`
        + (isAuto ? ` <button class="dom-auto" data-company="${esc(c.company)}" data-domain="${esc(domain)}" data-tip="Auto-resolved from the company name — a best guess, verified against the site. Click to confirm or change it.">auto</button>` : "")
        + ` <button class="co-sig-check" data-domain="${esc(domain)}" data-tip="Check this company's sales signals now">Check signals</button>`
      : `<button class="co-addom" data-company="${esc(c.company)}" data-tip="Add this company's website to enable signal checks">+ Add domain</button>`;
    return `<tr class="co-row" data-company="${esc(c.company)}" style="--i:${i}">
      <td class="company">${bulkCbHtml("companies", c.company, domain)}${esc(c.company)}</td>
      <td class="co-dom-cell">${domCell}</td>
      <td style="font-variant-numeric:tabular-nums">${c.openRoles}${Number(c.roles) > Number(c.openRoles) ? ` <span style="color:var(--faint)">/ ${c.roles}</span>` : ""}</td>
      <td><span class="heat heat-${heat}">${c.score}</span></td>
      <td>${monitors.slice(0, 3).map(m => `<span class="chip client">${esc(m)}</span>`).join(" ")}${monitors.length > 3 ? ` +${monitors.length - 3}` : ""}</td>
      <td style="font-variant-numeric:tabular-nums" data-tip="Highest stated salary across this company's postings. Currencies are not converted, so this is not necessarily dollars.">${c.maxSalary ? fmtSalaryCeiling(c.maxSalary) : '<span style="color:var(--faint)">—</span>'}</td>
      <td style="white-space:nowrap">${fmtAgoHtml(c.lastSeen)}</td>
    </tr>`;
  }).join("");
  // whole row → open that company's postings
  // While a bulk selection is in progress a plain row click must NOT navigate — it discards the
  // selection silently. Signals>Companies already guarded this; Companies and Home did not.
  $("coRows").querySelectorAll(".co-row").forEach(tr => rowActivate(tr, () => {
    if (bulkSC.surf) return;
    const co = tr.getAttribute("data-company");
    state.postTab = "postings"; postTabHtml("postings");
    $("q").value = co; resetAndLoad();
  }));
  $("coRows").querySelectorAll(".co-sig-check").forEach(b => b.onclick = (e) => { e.stopPropagation(); openDomainCheck(b.dataset.domain); });
  // click-to-add (empty) / click-to-edit (auto) domain → inline editor in the cell
  $("coRows").querySelectorAll(".co-addom, .dom-auto").forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    coEditDomain(b.closest(".co-dom-cell"), b.dataset.company, b.dataset.domain || "");
  });
  // Sortable headers via the SHARED helper. This and the two below re-implemented the same six
  // lines and each left out the two the helper adds — tabIndex and an Enter/Space handler — so 13
  // sortable columns across Companies, Home and Signals>Companies were mouse-only.
  wireSortHeaders("#coHead", "data-sort", () => coState.sort, () => coState.dir, (k, dir) => {
    coState.sort = k; coState.dir = dir; coState.offset = 0; loadCompanies({ background: true });
  });
  bulkWire("companies", $("coRows"));
  coPager();
}
function coPager() {
  const start = coState.total ? coState.offset + 1 : 0, end = Math.min(coState.offset + coState.limit, coState.total);
  $("pageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(coState.total)} companies`;
  $("pageNum").textContent = `Page ${Math.floor(coState.offset / coState.limit) + 1} of ${Math.max(1, Math.ceil(coState.total / coState.limit))}`;
  $("prev").disabled = coState.offset === 0; $("next").disabled = end >= coState.total;
}
$("coExport").onclick = () => { const a = document.createElement("a"); a.href = "/api/companies/export?" + coScopeParams(); a.download = ""; a.click(); };
$("coCopy").onclick = async () => {
  try {
    const rows = await (await fetch("/api/companies/export?" + coScopeParams())).text();
    // keep just company,domain columns for a paste-into-Clay/LGM list
    const lines = rows.split("\n"); const out = lines.map((l, i) => { const c = l.split(","); return i === 0 ? "company,domain" : `${c[0]},${c[1] || ""}`; }).join("\n");
    await navigator.clipboard.writeText(out);
    toast(`Copied ${Math.max(0, lines.length - 1)} companies to clipboard`);
  } catch (e) { toast("Copy failed: " + e.message, true); }
};

// Postings-tab export/copy. Both send filterParams() — the SAME query the visible list was built
// from — so "download what I'm looking at" is literally true, including the advanced-filter tree.
// No limit/offset: the server exports the whole filtered set, not the page you happen to be on.
$("poExport").onclick = () => {
  const a = document.createElement("a");
  a.href = "/api/matches/export?" + filterParams();
  a.download = ""; a.click();
};
$("poCopy").onclick = async () => {
  setBtnLoading("poCopy", true, "Copying…");
  try {
    const csv = await (await fetch("/api/matches/export?" + filterParams())).text();
    const lines = csv.split("\n");
    // company, role, apply link — the three columns you actually paste into an outreach tool.
    const out = lines.map((l, i) => {
      if (i === 0) return "company,role,url";
      const c = splitCsvLine(l);
      return [c[0] ?? "", c[2] ?? "", c[12] ?? ""].map(csvCell).join(",");
    }).join("\n");
    await navigator.clipboard.writeText(out);
    toast(`Copied ${Math.max(0, lines.length - 1)} postings to clipboard`);
  } catch (e) { toast("Copy failed: " + e.message, true); }
  finally { setBtnLoading("poCopy", false); }
};
/** Split one CSV line, honouring quoted fields. A plain .split(",") tears any company or role that
 *  contains a comma — "Foo, Inc." — and silently shifts every column after it. */
function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
const csvCell = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

// Inline add/edit of a company's domain (empty cell → add; "auto" chip → confirm/replace). Saving
// always stores a 'manual' override, which drops the auto badge and unlocks "Check signals".
function coEditDomain(cell, company, current, reload = loadCompanies) {
  if (!cell) return;
  cell.innerHTML = `<span class="co-dom-edit"><input class="co-dom-input" type="text" placeholder="stripe.com" value="${esc(current)}" aria-label="Domain for ${esc(company)}"/><button class="co-dom-save">Save</button><button class="co-dom-cancel">Cancel</button></span>`;
  const input = cell.querySelector(".co-dom-input");
  input.onclick = (e) => e.stopPropagation();
  input.focus(); input.select();
  const save = async () => {
    const domain = input.value.trim();
    if (!domain) return;
    try {
      const res = await fetch("/api/companies/domain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company, domain }) });
      const data = await res.json();
      if (!res.ok) return toast(data.error || "Could not save domain", true);
      toast(`Saved ${data.domain} for ${company}`); reload();
    } catch (e) { toast("Save failed: " + e.message, true); }
  };
  cell.querySelector(".co-dom-save").onclick = (e) => { e.stopPropagation(); save(); };
  cell.querySelector(".co-dom-cancel").onclick = (e) => { e.stopPropagation(); reload(); };
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); reload(); } };
}
// Bulk resolve: work through EVERY company missing a website (all pages, not just this one) in
// bounded server batches, with live progress on the button. Failed companies are negative-cached
// server-side (retried after a week), so re-runs only chase genuinely new names.
async function resolveAllDomains(btn, reload) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = "Resolving…";
  let found = 0, notFound = 0;
  try {
    for (;;) {
      const res = await fetch("/api/companies/resolve-domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true, max: 40 }) });
      const d = await res.json();
      if (!res.ok) { toast(d.error || "Resolve failed", true); break; }
      found += d.resolved.length; notFound += d.failed.length;
      if (!d.resolved.length && !d.failed.length) break;      // backlog empty (or all negative-cached)
      btn.textContent = `Resolving… ${fmtNum(found)} found · ${fmtNum(d.remaining)} left`;
      reload();                                               // stream results into the table as they land
      if (!d.remaining) break;
    }
    toast(found || notFound
      ? `Found ${fmtNum(found)} website${found === 1 ? "" : "s"}${notFound ? ` · ${fmtNum(notFound)} not found (retried in a week)` : ""}`
      : "Every company already has a website (or was tried recently)");
  } catch (e) { toast("Resolve failed: " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; reload(); }
}
$("coResolve").onclick = () => resolveAllDomains($("coResolve"), loadCompanies);

// ── Accounts home: ONE ranked list across every monitor + a plain-English "why now" per company ──────
// The SDR's default screen. Calls /api/companies with NO kind/client (unified cross-kind list). "Why now"
// = velocity facts (instant, from the row) + current signal summaries (one batch /api/domain-flags call).
const homeState = { offset: 0, limit: 15, total: 0, sort: "score", dir: "desc", q: "" };
function homeWhyNow(c) {
  const chips = [], open = Number(c.openRoles) || 0, recent = Number(c.recentRoles) || 0;
  if (open > 0) chips.push(`<span class="why-chip why-hire">${open} open role${open === 1 ? "" : "s"}</span>`);
  if (recent > 0) chips.push(`<span class="why-chip why-fresh">+${recent} in 14d</span>`);
  if (c.maxSalary) chips.push(`<span class="why-chip why-sal" data-tip="Highest stated salary across this company's postings. Currencies are not converted.">${fmtSalaryCeiling(c.maxSalary)} ceiling</span>`);
  return chips.join("") || '<span class="why-empty">—</span>';
}
async function loadHome(opts) {
  const tok = loadToken("home");
  maybeSkeleton(opts, "homeRows", 6, homeState.limit);
  const p = new URLSearchParams(); // no kind/client → unified list across Client + Account monitoring
  if (homeState.q) p.set("q", homeState.q);
  p.set("sort", homeState.sort); p.set("dir", homeState.dir);
  p.set("limit", homeState.limit); p.set("offset", homeState.offset);
  let d; try { d = await fjson("/api/companies?" + p); }
  catch {
    if (loadStale("home", tok)) return;
    $("homeRows").innerHTML = `<tr><td colspan="6" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("home", loadHome); return;
  }
  if (loadStale("home", tok)) return;
  homeState.total = d.total;
  $("homeEmpty").style.display = d.items.length ? "none" : "block";
  $("homeRows").innerHTML = d.items.map((c, i) => {
    const domain = String(c.domains || "").split(",").filter(Boolean)[0] || "";
    const isAuto = c.domainSource === "auto";
    const monitors = String(c.monitors || "").split(",").filter(Boolean);
    const heat = Number(c.score) >= 15 ? "hot" : Number(c.score) >= 6 ? "warm" : "cool";
    const domCell = domain
      ? `<a class="dom" href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)}</a>`
        + (isAuto ? ` <button class="dom-auto" data-company="${esc(c.company)}" data-domain="${esc(domain)}" data-tip="Auto-resolved from the company name — a verified best guess. Click to confirm or change.">auto</button>` : "")
        + ` <button class="co-sig-check" data-domain="${esc(domain)}" data-tip="Check this company's sales signals now">Check signals</button>`
      : `<button class="co-addom" data-company="${esc(c.company)}" data-tip="Add this company's website to enable signal checks">+ Add domain</button>`;
    return `<tr class="co-row home-row" data-company="${esc(c.company)}" data-domain="${esc(domain)}" data-monitors="${esc(monitors.join(","))}" style="--i:${i}">
      <td class="company"><div class="home-co-cell">${bulkCbHtml("home", c.company, domain)}<div class="home-co-txt"><div class="home-co-name">${esc(c.company)}</div><div class="home-co-dom">${domCell}</div></div></div></td>
      <td class="home-why">${homeWhyNow(c)}</td>
      <td><span class="heat heat-${heat}">${c.score}</span></td>
      <td style="font-variant-numeric:tabular-nums">${c.openRoles}${Number(c.roles) > Number(c.openRoles) ? ` <span style="color:var(--faint)">/ ${c.roles}</span>` : ""}</td>
      <td>${monitors.slice(0, 2).map(m => `<span class="chip client">${esc(m)}</span>`).join(" ")}${monitors.length > 2 ? ` +${monitors.length - 2}` : ""}</td>
      <td style="white-space:nowrap">${fmtAgoHtml(c.lastSeen)}</td>
    </tr>`;
  }).join("");
  $("homeRows").querySelectorAll(".home-row").forEach(tr => rowActivate(tr, () => { if (!bulkSC.surf) homeOpenCompany(tr.dataset.company, tr.dataset.monitors); }));
  $("homeRows").querySelectorAll(".co-sig-check").forEach(b => b.onclick = (e) => { e.stopPropagation(); openDomainCheck(b.dataset.domain); });
  $("homeRows").querySelectorAll(".co-addom, .dom-auto").forEach(b => b.onclick = (e) => { e.stopPropagation(); coEditDomain(b.closest(".home-co-dom"), b.dataset.company, b.dataset.domain || "", loadHome); });
  wireSortHeaders("#homeHead", "data-sort", () => homeState.sort, () => homeState.dir, (k, dir) => {
    homeState.sort = k; homeState.dir = dir; homeState.offset = 0; loadHome();
  });
  bulkWire("home", $("homeRows"));
  homePager();
  homeEnrichSignals(d.items); // async: batch-fetch current signal flags → inject "why now" signal chips
}
async function homeEnrichSignals(items, rowsElId = "homeRows") {
  const domains = [...new Set(items.map(c => String(c.domains || "").split(",").filter(Boolean)[0]).filter(Boolean))];
  if (!domains.length) return;
  // Chunked to the server's per-request ceiling. This was ONE request for every domain on the page,
  // and the server silently served only the first 100 — the same number as the largest page size, so
  // the tail of a full page would have shown "never scanned" for companies that had been scanned,
  // with nothing to indicate why. Chunking makes the page size and the request size independent.
  const DOMAIN_FLAG_BATCH = 100;
  const flags = {}, checked = {};
  for (let i = 0; i < domains.length; i += DOMAIN_FLAG_BATCH) {
    const part = domains.slice(i, i + DOMAIN_FLAG_BATCH);
    let d; try { d = await fjson("/api/domain-flags?domains=" + encodeURIComponent(part.join(","))); } catch { return; }
    Object.assign(flags, d.flags || {});
    Object.assign(checked, d.checked || {});
  }
  $(rowsElId).querySelectorAll(".home-row").forEach(tr => {
    const dom = tr.dataset.domain;
    const cell = tr.querySelector(".home-why"); if (!cell || !dom) return;
    const hits = flags[dom];
    if (!hits || !hits.length) {
      // "We looked and found nothing" and "we have never looked" are different answers, and the
      // column showed them as the same blank cell — so a company nobody had scanned looked like a
      // company with no signals. Say which.
      const when = checked[dom];
      const scanned = dom in checked;
      cell.insertAdjacentHTML("beforeend", scanned
        ? `<span class="why-chip why-none" data-tip="Every signal we run came back negative${when ? " when we last checked, " + esc(fmtAgo(when)) : ""}. This is a measurement, not a gap.">no signals${when ? " · " + esc(fmtAgo(when)) : ""}</span>`
        : `<span class="why-chip why-unknown" data-tip="Nobody has run a signal check on this company yet — this is not the same as having no signals. Use Check signals to look.">not checked</span>`);
      return;
    }
    cell.querySelector(".why-empty")?.remove();
    // Date the chips. A "raised" chip with no date is indistinguishable from one found 18 months ago.
    cell.insertAdjacentHTML("beforeend", hits.slice(0, 3).map(h => {
      const ago = h.checkedAt ? fmtAgo(h.checkedAt) : "";
      // PRODUCER_LABELS, not the raw key — hovering used to show "edgar" / "ph" / "gdelt".
      const who = PRODUCER_LABELS[h.producer] || h.producer;
      return `<span class="why-chip why-sig" data-tip="${esc(who)}${ago ? " · last checked " + esc(ago) : ""}">${esc(h.summary || who)}${ago ? ` <span class="why-when">${esc(ago)}</span>` : ""}</span>`;
    }).join(""));
  });
}
function homePager() {
  const start = homeState.total ? homeState.offset + 1 : 0, end = Math.min(homeState.offset + homeState.limit, homeState.total);
  $("homePageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(homeState.total)} companies`;
  $("homePageNum").textContent = `Page ${Math.floor(homeState.offset / homeState.limit) + 1} of ${Math.max(1, Math.ceil(homeState.total / homeState.limit))}`;
  $("homePrev").disabled = homeState.offset === 0; $("homeNext").disabled = end >= homeState.total;
}
// Jump to that company's roles — in whichever view actually holds them.
//
// This always went to Client Monitoring, whose KIND_OF_VIEW is "search". /api/matches then resolves
// its client list from that kind alone, so a company tracked only by an Account Monitoring watchlist
// matched nothing: the top row of the default landing screen (Stripe, 362 open roles) answered
// "No matches for these filters." while the same query at kind=watchlist returned 363. Route by the
// company's own monitors instead, falling back to Client Monitoring when we cannot tell.
function homeOpenCompany(company, monitors = "") {
  const names = String(monitors).split(",").map((s) => s.trim()).filter(Boolean);
  const isWatchlist = names.some((n) => (CONFIGS.find((c) => c.name === n) || {}).kind === "watchlist");
  const view = isWatchlist ? "accounts" : "clients";
  showView(view);
  setTimeout(() => { state.postTab = "postings"; postTabHtml("postings"); $("q").value = company; resetAndLoad(); }, 60);
}
$("homePrev").onclick = () => { homeState.offset = Math.max(0, homeState.offset - homeState.limit); loadHome(); };
$("homeNext").onclick = () => { homeState.offset += homeState.limit; loadHome(); };
let homeSearchT;
$("homeSearch").oninput = () => { clearTimeout(homeSearchT); homeSearchT = setTimeout(() => { homeState.q = $("homeSearch").value.trim(); homeState.offset = 0; loadHome(); }, 250); };
$("homeResolve").onclick = () => resolveAllDomains($("homeResolve"), loadHome);
// "+ Add companies" — one front door to the three existing create flows.
$("homeAddBtn").onclick = (e) => { e.stopPropagation(); const m = $("homeAddMenu"); const open = !m.hidden; m.hidden = open; $("homeAddBtn").setAttribute("aria-expanded", String(!open)); };
// Empty-state CTA buttons declare their destination as a data- attribute instead of an inline
// onclick=, so the Content-Security-Policy can forbid inline script outright (script-src 'self').
// Delegated, so it keeps working for markup re-rendered via innerHTML.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-goview],[data-gosigtab],[data-proxyclick]");
  if (!t) return;
  if (t.dataset.goview) showView(t.dataset.goview);
  else if (t.dataset.gosigtab) sigShowTab(t.dataset.gosigtab);
  else if (t.dataset.proxyclick) $(t.dataset.proxyclick)?.click();
});

document.addEventListener("click", () => { const m = $("homeAddMenu"); if (m && !m.hidden) { m.hidden = true; $("homeAddBtn").setAttribute("aria-expanded", "false"); } });
$("homeAddMenu").onclick = (e) => e.stopPropagation();
$("homeAddMenu").querySelectorAll("[data-add]").forEach(b => b.onclick = () => {
  $("homeAddMenu").hidden = true;
  const kind = b.dataset.add;
  // All three now open the ONE unified creator (or the CSV-based check screen for large lists),
  // pre-set to the matching cadence/target.
  if (kind === "keyword") { showView("clients"); setTimeout(() => openEditor(null, { cadence: "watch" }), 60); }
  else if (kind === "watch") { showView("clients"); setTimeout(() => openEditor(null, { cadence: "watch", focus: "domains" }), 60); }
  else if (kind === "check") { showView("checking"); setTimeout(() => $("acNewBtn").click(), 60); }
});

// ── Signals → Companies sub-tab: the same cross-kind account list, built for bulk signal-checking ──
// Mirrors the Home list (unified /api/companies + "why now") into its own container so an SDR can sit
// in the Signals area, pick a batch of companies, and run one check across all of them.
const sigcoState = { offset: 0, limit: 15, total: 0, sort: "score", dir: "desc", q: "" };
async function loadSigCompanies(opts) {
  const tok = loadToken("sigco");
  maybeSkeleton(opts, "sigcoRows", 5, sigcoState.limit);
  const p = new URLSearchParams(); // no kind/client → unified list across Client + Account monitoring
  if (sigcoState.q) p.set("q", sigcoState.q);
  p.set("sort", sigcoState.sort); p.set("dir", sigcoState.dir);
  p.set("limit", sigcoState.limit); p.set("offset", sigcoState.offset);
  let d; try { d = await fjson("/api/companies?" + p); }
  catch {
    if (loadStale("sigco", tok)) return;
    $("sigcoRows").innerHTML = `<tr><td colspan="5" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("sigco", loadSigCompanies); return;
  }
  if (loadStale("sigco", tok)) return;
  sigcoState.total = d.total;
  $("sigcoEmpty").style.display = d.items.length ? "none" : "block";
  $("sigcoRows").innerHTML = d.items.map((c, i) => {
    const domain = String(c.domains || "").split(",").filter(Boolean)[0] || "";
    const isAuto = c.domainSource === "auto";
    const heat = Number(c.score) >= 15 ? "hot" : Number(c.score) >= 6 ? "warm" : "cool";
    const domCell = domain
      ? `<a class="dom" href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)}</a>`
        + (isAuto ? ` <button class="dom-auto" data-company="${esc(c.company)}" data-domain="${esc(domain)}" data-tip="Auto-resolved from the company name — a verified best guess. Click to confirm or change.">auto</button>` : "")
      : `<button class="co-addom" data-company="${esc(c.company)}" data-tip="Add this company's website to enable signal checks">+ Add domain</button>`;
    return `<tr class="co-row home-row" data-company="${esc(c.company)}" data-domain="${esc(domain)}" data-monitors="${esc(String(c.monitors || ""))}" style="--i:${i}">
      <td class="company"><div class="home-co-cell">${bulkCbHtml("sigco", c.company, domain)}<div class="home-co-txt"><div class="home-co-name">${esc(c.company)}</div><div class="home-co-dom">${domCell}</div></div></div></td>
      <td class="home-why">${homeWhyNow(c)}</td>
      <td><span class="heat heat-${heat}">${c.score}</span></td>
      <td style="font-variant-numeric:tabular-nums">${c.openRoles}${Number(c.roles) > Number(c.openRoles) ? ` <span style="color:var(--faint)">/ ${c.roles}</span>` : ""}</td>
      <td style="white-space:nowrap">${fmtAgoHtml(c.lastSeen)}</td>
    </tr>`;
  }).join("");
  $("sigcoRows").querySelectorAll(".home-row").forEach(tr => rowActivate(tr, () => { if (!bulkSC.surf) homeOpenCompany(tr.dataset.company, tr.dataset.monitors); }));
  $("sigcoRows").querySelectorAll(".co-addom, .dom-auto").forEach(b => b.onclick = (e) => { e.stopPropagation(); coEditDomain(b.closest(".home-co-dom"), b.dataset.company, b.dataset.domain || "", loadSigCompanies); });
  wireSortHeaders("#sigcoHead", "data-sort", () => sigcoState.sort, () => sigcoState.dir, (k, dir) => {
    sigcoState.sort = k; sigcoState.dir = dir; sigcoState.offset = 0; loadSigCompanies();
  });
  bulkWire("sigco", $("sigcoRows"));
  sigcoPager();
  homeEnrichSignals(d.items, "sigcoRows");
}
function sigcoPager() {
  const start = sigcoState.total ? sigcoState.offset + 1 : 0, end = Math.min(sigcoState.offset + sigcoState.limit, sigcoState.total);
  $("sigcoPageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(sigcoState.total)} companies`;
  $("sigcoPageNum").textContent = `Page ${Math.floor(sigcoState.offset / sigcoState.limit) + 1} of ${Math.max(1, Math.ceil(sigcoState.total / sigcoState.limit))}`;
  $("sigcoPrev").disabled = sigcoState.offset === 0; $("sigcoNext").disabled = end >= sigcoState.total;
}
$("sigcoPrev").onclick = () => { sigcoState.offset = Math.max(0, sigcoState.offset - sigcoState.limit); loadSigCompanies(); };
$("sigcoNext").onclick = () => { sigcoState.offset += sigcoState.limit; loadSigCompanies(); };
let sigcoSearchT;
$("sigcoSearch").oninput = () => { clearTimeout(sigcoSearchT); sigcoSearchT = setTimeout(() => { sigcoState.q = $("sigcoSearch").value.trim(); sigcoState.offset = 0; loadSigCompanies(); }, 250); };

// ══ Bulk signal check ═══════════════════════════════════════════════════════════════════════════
// Pick companies on ANY list (Home, Companies, Signals→Companies) and run ONE saved Signal Check
// across all their websites at once — reusing the Checks harness (progress bar, results grid, saved).
// Row checkboxes stay hidden until the surface's "Bulk check signals" button is pressed. Selection is
// keyed by domain, so it survives paging. Companies with no website can't be picked (nothing to check).
const bulkSC = { surf: null, sel: new Map() }; // sel: domain -> company name
const BULK_ROWS = { home: "homeRows", companies: "coRows", sigco: "sigcoRows" };
const bulkReload = (surf) => ({ home: loadHome, companies: loadCompanies, sigco: loadSigCompanies }[surf] || (() => {}));
const bulkRowsEl = () => bulkSC.surf ? $(BULK_ROWS[bulkSC.surf]) : null;

// Checkbox that prepends into a company cell — only while THIS surface is in bulk mode.
function bulkCbHtml(surf, company, domain) {
  if (bulkSC.surf !== surf) return "";
  if (!domain) return `<span class="bulk-cb bulk-cb-off" data-tip="Add this company's website first — signals need a domain to check">–</span>`;
  return `<label class="bulk-cb"><input type="checkbox" class="bulk-row-cb" aria-label="Select ${esc(company || domain)}" data-domain="${esc(domain)}" data-company="${esc(company)}" ${bulkSC.sel.has(domain) ? "checked" : ""}/></label>`;
}
// Wire every checkbox in a freshly-rendered rows container + refresh the floating bar.
function bulkWire(surf, rowsEl) {
  if (bulkSC.surf !== surf || !rowsEl) return;
  rowsEl.querySelectorAll(".bulk-row-cb").forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      if (cb.checked) bulkSC.sel.set(cb.dataset.domain, cb.dataset.company);
      else bulkSC.sel.delete(cb.dataset.domain);
      bulkBarSync();
    };
  });
  bulkBarSync();
}
// Enter/leave bulk mode for a surface; reload() re-renders its rows with/without checkboxes.
function bulkToggle(surf) {
  bulkSC.surf = bulkSC.surf === surf ? null : surf;
  bulkSC.sel.clear();
  document.querySelectorAll("[data-bulk-toggle]").forEach(b => b.classList.toggle("on", b.dataset.bulkToggle === bulkSC.surf));
  bulkBarSync();
  bulkReload(surf)();
}
// Leave bulk mode without re-rendering (used when the surface is being hidden anyway).
function bulkExit() {
  if (!bulkSC.surf) return;
  bulkSC.surf = null; bulkSC.sel.clear();
  document.querySelectorAll("[data-bulk-toggle]").forEach(b => b.classList.remove("on"));
  bulkBarSync();
}
function bulkSelectAllPage() {
  const rowsEl = bulkRowsEl(); if (!rowsEl) return;
  rowsEl.querySelectorAll(".bulk-row-cb").forEach(cb => { cb.checked = true; bulkSC.sel.set(cb.dataset.domain, cb.dataset.company); });
  bulkBarSync();
}
// The scope/search that the current surface is showing — so "Select all" matches what's on screen.
function bulkScopeParams(surf) {
  if (surf === "companies") return coScopeParams(); // client/kind/signal filters
  const p = new URLSearchParams();                  // home/sigco = unified cross-kind list
  const q = surf === "home" ? homeState.q : sigcoState.q;
  if (q) p.set("q", q);
  return p;
}
// Select EVERY matching company across all pages (only those with a website — a check needs a domain).
async function bulkSelectAllMatches() {
  const surf = bulkSC.surf; if (!surf) return;
  const btn = $("bulkBarAllMatches"), orig = btn.textContent;
  btn.disabled = true; btn.textContent = "Selecting…";
  try {
    const d = await fjson("/api/companies/all-domains?" + bulkScopeParams(surf));
    (d.items || []).forEach(it => { if (it.domain) bulkSC.sel.set(it.domain, it.company); });
    bulkRowsEl()?.querySelectorAll(".bulk-row-cb").forEach(cb => { if (bulkSC.sel.has(cb.dataset.domain)) cb.checked = true; });
    bulkBarSync();
    const withDom = d.withDomain || 0, skipped = (d.total || 0) - withDom;
    toast(`Selected ${fmtNum(withDom)} compan${withDom === 1 ? "y" : "ies"} with a website${skipped > 0 ? ` · ${fmtNum(skipped)} skipped (no domain yet)` : ""}`);
  } catch (e) { toast("Couldn't select all: " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
// One shared floating action bar (created lazily on <body>).
function bulkBar() {
  let el = $("bulkBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "bulkBar"; el.className = "bulk-bar"; el.hidden = true;
    el.innerHTML = `<span class="bulk-bar-count" id="bulkBarCount">0 selected</span>
      <div class="bulk-bar-actions">
        <button class="linklike" id="bulkBarAll" type="button" data-tip="Tick every company shown on this page">Select page</button>
        <button class="linklike" id="bulkBarAllMatches" type="button" data-tip="Tick every matching company across all pages (only those with a website)">Select all</button>
        <button class="btn primary" id="bulkBarRun" type="button">Check signals</button>
        <button class="linklike" id="bulkBarCancel" type="button">Cancel</button>
      </div>`;
    document.body.appendChild(el);
    $("bulkBarRun").onclick = bulkRun;
    $("bulkBarCancel").onclick = () => { const s = bulkSC.surf; bulkExit(); if (s) bulkReload(s)(); };
    $("bulkBarAll").onclick = bulkSelectAllPage;
    $("bulkBarAllMatches").onclick = bulkSelectAllMatches;
  }
  return el;
}
function bulkBarSync() {
  const el = bulkBar();
  if (!bulkSC.surf) { el.hidden = true; return; }
  const n = bulkSC.sel.size;
  el.hidden = false;
  $("bulkBarCount").textContent = `${fmtNum(n)} compan${n === 1 ? "y" : "ies"} selected`;
  $("bulkBarRun").disabled = n === 0;
}
async function bulkRun() {
  const domains = [...bulkSC.sel.keys()];
  if (!domains.length) return toast("Pick at least one company first", true);
  const catalogue = await sigProducers();
  if (!catalogue) return toast("Couldn\u2019t load the signal types — the engine may be busy. Try again in a moment.", true);
  const signals = catalogue.map(p => p.key);
  if (!signals.length) return toast("No signal types available", true);
  const n = domains.length;
  const runBtn = $("bulkBarRun"), orig = runBtn.textContent;
  runBtn.disabled = true; runBtn.textContent = "Starting…";
  try {
    const res = await fetch("/api/signal-checks", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Bulk check — ${n} compan${n === 1 ? "y" : "ies"}`, domains, signals }) });
    const d = await res.json();
    if (!res.ok) { toast(d.error || "Couldn't start the check", true); return; }
    toast(capNote(d) || `Checking ${fmtNum(d.count)} compan${d.count === 1 ? "y" : "ies"} across every signal…`, !!d.capped);
    bulkExit();                 // clears surf so showView's exit is a no-op
    showView("signals");
    sigShowTab("checks");
    scOpenDetail(d.id);          // stream the running check
  } catch (e) { toast("Couldn't start: " + e.message, true); }
  finally { runBtn.textContent = orig; runBtn.disabled = false; }
}
// Wire the per-surface toggle buttons (all present in static markup at load).
document.querySelectorAll("[data-bulk-toggle]").forEach(b => b.onclick = (e) => { e.stopPropagation(); bulkToggle(b.dataset.bulkToggle); });

// ---- Triage: star / hide / NEW ----
// "Seen" watermark per scope (client or kind): matches found after it are NEW; viewing a scope clears it.
const seenKey = () => "se_seen:" + (state.client || ("k:" + state.kind));
const lastSeenTs = () => localStorage.getItem(seenKey()) || "";
function markSeen() { localStorage.setItem(seenKey(), new Date().toISOString().replace("T", " ").slice(0, 19)); refreshUnseenBadges(); }
const isNew = (matchedAt, since) => !!matchedAt && !!since && String(matchedAt) > String(since);

function wireTriage(root) {
  if (!root) return;
  root.querySelectorAll("[data-star]").forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute("data-star"); const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on); btn.innerHTML = icon(on ? "starFill" : "star");
    btn.closest(".job-row")?.classList.toggle("is-starred", on);
    if (matchRowsById[id]) matchRowsById[id].starred = on ? 1 : 0;
    try { await fetch(`/api/jobs/${encodeURIComponent(id)}/star`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: on }) }); }
    catch { toast("Couldn't save star", true); }
  });
  root.querySelectorAll("[data-hide]").forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute("data-hide"); const tr = btn.closest(".job-row");
    const sc = filterParams(); // same client/kind scope as the current view
    const qs = new URLSearchParams(); if (sc.get("client")) qs.set("client", sc.get("client")); else qs.set("kind", state.kind);
    if (!await mutate(`/api/jobs/${encodeURIComponent(id)}/hide?` + qs, { method: "POST" }, "Could not hide that job")) return;
    if (tr) tr.style.display = "none";
    toastUndo("Hidden.", async () => {
      // The undo needs the same treatment: a failed unhide left the job hidden with the user
      // believing it was restored.
      if (await mutate(`/api/jobs/${encodeURIComponent(id)}/unhide?` + qs, { method: "POST" }, "Could not restore that job")) loadMatches({ background: true });
    });
  });
}
// Toast with an Undo action.
function toastUndo(msg, onUndo) {
  const c = liveRegion(false);
  const t = document.createElement("div"); t.className = "toast";
  t.innerHTML = `<span class="ti">${icon("check")}</span><span>${esc(msg)}</span> <button class="toast-undo">Undo</button>`;
  c.appendChild(t); requestAnimationFrame(() => t.classList.add("in"));
  const kill = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); };
  t.querySelector(".toast-undo").onclick = () => { onUndo(); kill(); };
  setTimeout(kill, 6000);
}
// Sidebar NEW badges: per-kind unseen counts (matches found after each kind's seen watermark).
//
// COALESCED, because a single page load called this three times — the boot line, and markSeen()
// once per view the router settles through — for FIVE identical requests to /api/matches/unseen,
// measured on a cold load. Each one is a COUNT over the matches join, and node:sqlite is
// synchronous, so four of those five were the server blocking itself to recompute a number it had
// just computed. They also all landed in the same 300ms window as every other boot request.
//
// A call that arrives while one is in flight waits for it instead of starting another. It only
// re-runs afterwards if the watermarks actually MOVED while the request was out — which is the one
// case where the in-flight answer is genuinely stale, and is what markSeen() does.
let unseenInFlight = null, unseenWatermarks = "";
async function refreshUnseenBadges() {
  const marks = (localStorage.getItem("se_seen:k:search") || "") + "|" + (localStorage.getItem("se_seen:k:watchlist") || "");
  if (unseenInFlight) {
    if (marks === unseenWatermarks) return unseenInFlight;   // same question, already being asked
    await unseenInFlight;                                    // moved mid-flight → ask again, once
  }
  unseenWatermarks = marks;
  unseenInFlight = unseenBadgesNow();
  try { return await unseenInFlight; } finally { unseenInFlight = null; }
}
async function unseenBadgesNow() {
  const badge = (view, n) => {
    const btn = document.querySelector(`.side-item[data-view="${view}"]`); if (!btn) return;
    let b = btn.querySelector(".side-badge");
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement("span"); b.className = "side-badge"; btn.appendChild(b); }
    b.textContent = n > 99 ? "99+" : n;
  };
  try {
    const sSince = localStorage.getItem("se_seen:k:search") || "";
    const wSince = localStorage.getItem("se_seen:k:watchlist") || "";
    // The awaits were INSIDE the array literal, so both were resolved before Promise.all ever saw
    // them — the two requests ran strictly one after the other. Hand it promises, not values.
    const unseen = (since) => fetch("/api/matches/unseen?since=" + encodeURIComponent(since)).then((r) => r.json());
    const [s, w] = await Promise.all([
      sSince ? unseen(sSince) : Promise.resolve({ search: 0 }),
      wSince ? unseen(wSince) : Promise.resolve({ watchlist: 0 }),
    ]);
    badge("clients", s.search || 0); badge("accounts", w.watchlist || 0);
  } catch { /* leave badges as-is */ }
}

// Short salary band from the stored comp facets: "$110–150k", "$120k+", "€90k". — when absent.
// The Companies and Home tables show MAX(comp_max) aggregated across a company's postings, which the
// query computes with NO currency predicate — it is a maximum over whatever currencies that company
// happens to post in. Stamping "$" on it was the same invented-currency bug fmtSalary was fixed for,
// just on two other surfaces. No symbol, and a tooltip that says why.
const fmtSalaryCeiling = (v) => `${(Number(v) / 1000).toFixed(0)}k`;
function fmtSalary(r) {
  const lo = Number(r.compMin) || 0, hi = Number(r.compMax) || 0;
  if (!lo && !hi) return '<span style="color:var(--faint)">—</span>';
  // Unmapped codes (SGD/BRL/MXN and any scraped value) fall through to the raw string, which is
  // inserted via innerHTML by every caller — escape it so a hostile currency field can't inject markup.
  // No currency stated → show the bare number rather than assuming "$": most of these postings are
  // not US ones, and a "$" in front of a euro figure is simply a wrong number on screen.
  const cur = ({ USD: "$", EUR: "€", GBP: "£", CAD: "$", AUD: "$", INR: "₹" })[r.currency] || (r.currency ? esc(r.currency) + " " : "");
  const k = (n) => n >= 1000 ? (n % 1000 === 0 ? (n / 1000) + "k" : (n / 1000).toFixed(0) + "k") : String(n);
  const body = (lo && hi) ? `${k(lo)}–${k(hi)}` : (lo ? `${k(lo)}+` : `≤${k(hi)}`);
  return `${cur}${body}`;
}

// Whole-row click opens the detail drawer; inner links/buttons opt out via stopPropagation.
function wireJobRows(root, onOpen) {
  if (!root) return;
  root.querySelectorAll(".job-row").forEach((tr) => rowActivate(tr, () => {
    const id = tr.getAttribute("data-jobid"); if (id) onOpen(id);
  }));
}

// ---- Job detail drawer: full description + rich facts + links (from a matched-row click) ----
let jdReqSeq = 0; // bumps on every drawer open; async fetches check it so a late response can't paint a re-opened drawer
function openJobDrawer(r) {
  if (!r) return;
  const myReq = ++jdReqSeq;
  $("jdTitle").textContent = r.title || "Job";
  const facts = [];
  const sal = fmtSalary(r); if (!sal.includes("—")) facts.push(["Salary", sal]);
  if (r.yoe != null) facts.push(["Experience", `${esc(String(r.yoe))}+ yrs`]);
  if (r.employees != null) facts.push(["Company size", `${Number(r.employees).toLocaleString()} employees`]);
  if (r.seniority) facts.push(["Seniority", esc(listish(r.seniority))]);
  // 97 of 100 sampled jobs store industry as a JSON ARRAY STRING, so this printed
  // ["Accounting","Management Consulting"] — brackets, quotes and all — in the panel users open most.
  // esc() escaped it faithfully; nothing ever parsed it.
  if (r.industry) facts.push(["Industry", esc(listish(r.industry))]);
  if (r.state) facts.push(["State", esc(r.state)]);
  facts.push(["Remote", r.remote ? "Yes" : "No"]);
  facts.push(["Status", r.status === "closed" ? "Closed" : "Open"]);
  let tools = []; try { tools = Array.isArray(r.toolsJson) ? r.toolsJson : (r.toolsJson ? JSON.parse(r.toolsJson) : []); } catch { tools = []; }
  const monitors = r.clients ? r.clients.split(",") : (r.client ? [r.client] : []);
  const factsHtml = facts.map(([k, v]) => `<div class="jd-fact"><span class="jd-fk">${esc(k)}</span><span class="jd-fv">${v}</span></div>`).join("");
  $("jdBody").innerHTML = `
    <div class="jd-head">
      <div class="jd-co">${r.company ? esc(r.company) : ""}${r.domain ? ` · <a href="https://${esc(r.domain)}" target="_blank" rel="noopener">${esc(r.domain)}</a>` : ""}</div>
      <div class="jd-loc">${esc(r.location || "")}</div>
    </div>
    ${monitors.length ? `<div class="jd-monitors">${monitors.map(c => `<span class="chip client">${esc(c)}</span>`).join(" ")}</div>` : ""}
    <div class="jd-facts">${factsHtml}</div>
    ${tools.length ? `<div class="jd-sec">Tools & tech (from posting)</div><div class="jd-tools">${tools.slice(0, 40).map(t => `<span class="chip tool">${esc(String(t))}</span>`).join("")}</div>` : ""}
    <div id="jdTechSec" hidden><div class="jd-sec">Detected technologies</div><div class="jd-tools" id="jdTech"></div></div>
    <div class="jd-sec">Description</div>
    <div class="jd-desc">${r.description ? esc(r.description) : '<span style="color:var(--faint)">No description captured for this posting.</span>'}</div>
    <div class="jd-links">
      ${safeUrl(r.url) ? `<a class="btn primary" href="${safeUrl(r.url)}" target="_blank" rel="noopener">Open posting ↗</a>` : ""}
      <button class="btn ghost" id="jdStar">${Number(r.starred) ? icon('starFill') + " Starred" : icon('star') + " Star"}</button>
      <button class="btn ghost" id="jdHide">Not interested</button>
    </div>
    <div class="jd-dates">
      ${r.postedAt ? `Posted ${fmtAgoHtml(r.postedAt)}` : ""}${r.matchedAt ? ` · Found ${fmtAgoHtml(r.matchedAt)}` : ""}${r.lastSeenAt ? ` · Last seen ${fmtAgoHtml(r.lastSeenAt)}` : ""}
    </div>`;
  openDrawer("jdBg", "jobDrawer", closeJobDrawer);
  // Detected technologies (async — the n-gram detections stored per job, distinct from the posting's own tool tags)
  if (r.id) fetch(`/api/jobs/${encodeURIComponent(r.id)}/technologies`).then(x => x.json()).then((d) => {
    if (myReq !== jdReqSeq) return; // a newer drawer opened (or this one closed) → don't paint stale tech
    const techs = d.technologies || []; if (!techs.length) return;
    const sec = $("jdTechSec"), box = $("jdTech"); if (!sec || !box) return; // drawer may have closed
    box.innerHTML = techs.slice(0, 60).map(t => `<span class="chip tech">${esc(String(t))}</span>`).join("");
    sec.hidden = false;
  }).catch(() => {});
  // drawer star/hide actions
  $("jdStar").onclick = async () => {
    const on = !Number(r.starred); r.starred = on ? 1 : 0;
    $("jdStar").innerHTML = on ? icon('starFill') + " Starred" : icon('star') + " Star";
    if (matchRowsById[r.id]) matchRowsById[r.id].starred = r.starred;
    const rowBtn = document.querySelector(`[data-star="${CSS.escape(r.id)}"]`);
    if (rowBtn) { rowBtn.classList.toggle("on", on); rowBtn.innerHTML = icon(on ? "starFill" : "star"); rowBtn.closest(".job-row")?.classList.toggle("is-starred", on); }
    try { await fetch(`/api/jobs/${encodeURIComponent(r.id)}/star`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: on }) }); } catch { toast("Couldn't save star", true); }
  };
  $("jdHide").onclick = async () => {
    const qs = new URLSearchParams(); if (state.client) qs.set("client", state.client); else qs.set("kind", state.kind);
    if (!await mutate(`/api/jobs/${encodeURIComponent(r.id)}/hide?` + qs, { method: "POST" }, "Could not hide that job")) return;
    closeJobDrawer(); loadMatches({ background: true });
    toastUndo("Hidden.", async () => {
      if (await mutate(`/api/jobs/${encodeURIComponent(r.id)}/unhide?` + qs, { method: "POST" }, "Could not restore that job")) loadMatches({ background: true });
    });
  };
}
const closeJobDrawer = () => { jdReqSeq++; closeDrawer("jdBg", "jobDrawer"); };
$("jdCloseX").onclick = closeJobDrawer; $("jdBg").onclick = closeJobDrawer;

// Starred-only quick filter (matches views).
$("starFilter").onclick = () => {
  state.starredOnly = !state.starredOnly;
  $("starFilter").classList.toggle("active", state.starredOnly);
  $("starFilter").setAttribute("aria-pressed", state.starredOnly ? "true" : "false");
  resetAndLoad();
};

// ---- Job-description column: an always-visible clamped preview that expands inline. ----
// One shared cell renderer + post-render wiring, used by BOTH the matched-postings and jobs-database
// tables. The preview text shows on sight (3-line clamp); "Show more" only appears when it overflows.
/** The company cell — name on one clipping line, domain as a clipping sub-line, full name on hover.
 *  Extracted because four tables rendered this by hand and had already drifted: only one of them
 *  wrapped the name in an element, so in the other three a long name grew the row instead of
 *  truncating. `emptyDash` is false where a domain-only row is legitimate (the signal tables). */
function companyCellHtml(company, domain, { emptyDash = true, extra = "" } = {}) {
  const name = company
    ? `<span class="co-name">${esc(company)}</span>`
    : (emptyDash || !domain ? '<span class="none">—</span>' : "");
  const dom = domain
    ? `<a class="dom" href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)}</a>`
    : "";
  return `<td class="company"${company ? ` data-tip="${esc(company)}"` : ""}>${extra}${name}${dom}</td>`;
}
function jdCell(desc) {
  if (!desc) return '<td class="jd-col"><span class="jd-none">—</span></td>';
  return `<td class="jd-col"><div class="jd-prev">${esc(desc)}</div><button type="button" class="jd-toggle" hidden>Show more</button></td>`;
}
function wireJdCells(root) {
  if (!root) return;
  // scrollHeight and clientHeight are BOTH 0 inside a display:none container, so a render that
  // happens while the postings table is hidden (a background fetch completing on the Companies
  // sub-tab) measured every cell as unclamped and never showed a Show-more button — for that whole
  // render, until something re-rendered the rows. Defer the measurement until it can be taken.
  if (!root.checkVisibility?.() && !root.offsetParent) {
    if (root._jdPending) return;                 // already waiting on this container
    root._jdPending = new IntersectionObserver((entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect(); root._jdPending = null; wireJdCells(root);
    });
    root._jdPending.observe(root);
    return;
  }
  root.querySelectorAll(".jd-col").forEach((cell) => {
    const prev = cell.querySelector(".jd-prev"), btn = cell.querySelector(".jd-toggle");
    if (!prev || !btn) return;
    if (prev.scrollHeight - prev.clientHeight > 2) { // text is actually clamped → offer expand
      btn.hidden = false;
      btn.onclick = () => { const open = prev.classList.toggle("open"); btn.textContent = open ? "Show less" : "Show more"; };
    }
  });
}

// ---- Reversible "Hide old jobs" — scoped to the current tab (All clients = every search) ----
let oldSummary = { days: 30, oldCount: 0, hiddenCount: 0 };
async function refreshOldSummary() {
  // A failed request used to overwrite this with zeros, and zero is what hides both buttons — so a
  // timeout silently removed "Restore 3,781 hidden" from the toolbar and left the user believing
  // there was nothing hidden. Keep the last known counts (they were true when measured) and retry;
  // inventing a number is worse than showing a slightly stale one.
  try {
    oldSummary = await fjson("/api/jobs/old-summary" + scopeParam());
  } catch { retrySoon("oldSummary", refreshOldSummary); return; }
  const hideBtn = $("hideOldBtn"), restoreBtn = $("restoreBtn");
  hideBtn.style.display = oldSummary.oldCount > 0 ? "inline" : "none";
  hideBtn.textContent = `Hide ${fmtNum(oldSummary.oldCount)} old`;
  restoreBtn.style.display = oldSummary.hiddenCount > 0 ? "inline" : "none";
  restoreBtn.textContent = `Restore ${fmtNum(oldSummary.hiddenCount)} hidden`;
}
const scopeLabel = () => {
  if (state.client) return `"${state.client}"`;
  const n = CONFIGS.filter(c => (c.kind || "search") === state.kind).length;
  return `all ${n} ${kindNoun(n)}`;
};
$("hideOldBtn").onclick = async () => {
  if (!oldSummary.oldCount) return;
  const note = state.client ? `Other ${kindNoun(2)} keep these jobs.` : `This affects every ${kindNoun(1)} in this tab.`;
  if (!await uiConfirm(`Hide ${oldSummary.oldCount.toLocaleString()} job(s) older than ${oldSummary.days} days from ${scopeLabel()}?\n\nThey stay in the database — you can Restore them anytime. ${note}`, { title: "Hide old jobs", confirmLabel: "Hide" })) return;
  if (!await mutate("/api/jobs/hide-old" + scopeParam(), { method: "POST" }, "Could not hide old postings")) return;
  loadConfig(); loadStats(); loadMatches({ background: true });   // post-mutation: keep the rows on screen
};
$("restoreBtn").onclick = async () => {
  if (!oldSummary.hiddenCount) return;
  if (!await uiConfirm(`Restore ${oldSummary.hiddenCount.toLocaleString()} hidden job(s) to ${scopeLabel()}?`, { title: "Restore hidden jobs", confirmLabel: "Restore" })) return;
  if (!await mutate("/api/jobs/restore" + scopeParam(), { method: "POST" }, "Could not restore postings")) return;
  loadConfig(); loadStats(); loadMatches({ background: true });
};
$("verifyBtn").onclick = async () => {
  const scope = state.client ? `"${state.client}"` : `ALL ${kindNoun(2)}`;
  if (!await uiConfirm(`Re-check EVERY open posting in ${scope} by visiting its URL, and close any that are gone (404/410)?\n\nOne request per open posting — for a large scope this can take a few minutes. Bot-walled pages are left Open to avoid false closes.`, { title: "Verify open postings", confirmLabel: "Start check" })) return;
  const btn = $("verifyBtn"), orig = "Verify open";
  btn.disabled = true; btn.textContent = "Verifying…";
  const es = new EventSource("/api/jobs/verify-stream" + scopeParam());
  const stop = () => { es.close(); btn.disabled = false; btn.textContent = orig; };
  es.addEventListener("start", (e) => { const d = JSON.parse(e.data); btn.textContent = d.total ? `Verifying 0/${fmtNum(d.total)}…` : "Verifying…"; if (!d.total) { stop(); toast("No open postings to verify in this view."); } });
  es.addEventListener("progress", (e) => { const d = JSON.parse(e.data); btn.textContent = `Verifying ${fmtNum(d.checked)}/${fmtNum(d.total)}…`; });
  es.addEventListener("done", (e) => { const d = JSON.parse(e.data); stop(); toast(`Checked ${fmtNum(d.checked)} open posting(s); closed ${fmtNum(d.closed)} that were gone.`); loadStats(); loadMatches({ background: true }); });
  // An EventSource "error" with no data is a transport blip, and the browser reconnects on its own.
  // Calling stop() unconditionally closed the stream (killing that retry), re-enabled the button and
  // claimed failure — while the server carried on verifying, so the message was false and the user
  // could start a second run on top of the first. acStreamDetail already makes this distinction.
  // Tell a transient blip from a real failure by READYSTATE, not by e.data: this stream only ever
  // sends start/progress/done, so `if (!e.data) return` matched every error and stop() could never
  // run — a dropped connection left the button stuck on "Verifying n/m…" forever while EventSource
  // silently reconnected and the server started the whole sweep again from the top.
  let retries = 0;
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) { stop(); toast("Verify failed (connection lost).", true); return; }
    // CONNECTING: the browser is retrying by itself. Each retry re-runs the sweep server-side, so
    // this is capped rather than left to loop.
    if (++retries > 3) { stop(); toast("Verify kept losing the connection — stopped.", true); return; }
    btn.textContent = `Reconnecting… (${retries}/3)`;
  });
};
$("dedupeBtn").onclick = async () => {
  if (!await uiConfirm("Merge duplicate postings into one?\n\nThis finds rows that are the same real job (the same role listed more than once) and keeps a single row per posting. Your matches are preserved — they're moved onto the kept row. Applies across every search & watchlist.", { title: "Merge duplicates", confirmLabel: "Merge" })) return;
  const btn = $("dedupeBtn"), orig = btn.textContent;
  btn.textContent = "Removing…"; btn.disabled = true;
  try {
    const r = await (await fetch("/api/jobs/dedupe", { method: "POST" })).json();
    toast(r.removed ? `Removed ${fmtNum(r.removed)} duplicate posting(s) across ${fmtNum(r.groups)} group(s).` : "No duplicate postings found.");
    loadStats(); loadMatches({ background: true });
  } catch (e) { toast("Dedupe failed: " + e.message, true); }
  finally { btn.textContent = orig; btn.disabled = false; }
};

function renderPager() {
  const start = state.total ? state.offset + 1 : 0;
  const end = Math.min(state.offset + state.limit, state.total);
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  // A specific tab shows (job,client) matches; the combined "All" view groups to one row per job,
  // so call those "postings" — avoids reading as a different number than the "Total matches" stat.
  $("resultMeta").textContent = state.client
    ? `${fmtNum(state.total)} match${state.total === 1 ? "" : "es"}`
    : `${fmtNum(state.total)} posting${state.total === 1 ? "" : "s"}`;
  $("pageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(state.total)}`;
  $("pageNum").textContent = `Page ${Math.floor(state.offset / state.limit) + 1} of ${pages}`;
  $("prev").disabled = state.offset === 0;
  $("next").disabled = end >= state.total;
}

// Reload the visible table after a filter change — the Companies sub-tab shares this toolbar (the
// "Company signal" pill lives on it), so a filter change there must reload companies, not the hidden
// matches table. onCompaniesTab is a const defined just below; resolved at call time (runtime), never init.
function resetAndLoad() { if (onCompaniesTab()) { coState.offset = 0; loadCompanies(); } else { state.offset = 0; loadMatches(); } }
for (const id of ["state", "since", "status"]) $(id).onchange = resetAndLoad;
const onCompaniesTab = () => state.postTab === "companies";
$("pageSize").onchange = () => { if (onCompaniesTab()) { coState.limit = Number($("pageSize").value); coState.offset = 0; loadCompanies(); } else { state.limit = Number($("pageSize").value); resetAndLoad(); } };
// A CSS `transition: none` override cannot neutralize a scroll animation requested in JS, so this
// is the one place that has to read the preference itself. Everything else in the app animates
// through CSS and is already covered by the @media guard.
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const scrollResultsTop = () => (onCompaniesTab() ? $("coScroll") : $("tblScroll"))
  ?.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
$("prev").onclick = () => { if (onCompaniesTab()) { coState.offset = Math.max(0, coState.offset - coState.limit); loadCompanies(); } else { state.offset = Math.max(0, state.offset - state.limit); loadMatches(); } scrollResultsTop(); };
$("next").onclick = () => { if (onCompaniesTab()) { coState.offset += coState.limit; loadCompanies(); } else { state.offset += state.limit; loadMatches(); } scrollResultsTop(); };
let t; $("q").oninput = () => { clearTimeout(t); t = setTimeout(resetAndLoad, 250); };
$("qFuzzy").onchange = () => { if ($("q").value) resetAndLoad(); };

// ---- multi-select dropdowns (sources + remote) ----
const REMOTE_OPTS = [["remote", "Remote"], ["onsite", "On-site"]];

function buildMultiselect(panelId, btnId, opts, sel, label, onChange) {
  const panel = $(panelId), btn = $(btnId);
  // esc() both: neither the value nor the label is guaranteed to be a literal from this file — the
  // technology filter feeds it names straight from the dictionary, and the signal filters feed it
  // taxonomy labels. No current caller supplies attacker-controlled text, which makes this latent
  // rather than live; it is one `esc` either way.
  panel.innerHTML = opts.map(([v, l]) => `<label class="ms-opt"><input type="checkbox" value="${esc(v)}" ${sel.includes(v) ? "checked" : ""}/> ${esc(l)}</label>`).join("")
    + `<div class="ms-foot"><button type="button" class="linklike" data-act="all">Select all</button><button type="button" class="linklike" data-act="none">Clear</button></div>`;
  const sync = () => {
    sel.length = 0;
    panel.querySelectorAll('input:checked').forEach((c) => sel.push(c.value));
    btn.innerHTML = `${label}${sel.length ? ` <span class="badge">${sel.length}</span>` : ""} <span class="caret">${icon('chevron')}</span>`;
    onChange();
  };
  panel.onclick = (e) => e.stopPropagation(); // keep dropdown open while checking boxes
  panel.querySelectorAll('input').forEach((c) => c.onchange = sync);
  panel.querySelectorAll('.ms-foot [data-act]').forEach((a) => a.onclick = (e) => {
    e.stopPropagation();
    panel.querySelectorAll('input').forEach((c) => c.checked = a.dataset.act === "all");
    sync();
  });
  btn.onclick = (e) => { e.stopPropagation(); msToggle(panel, btn); };
}
document.addEventListener('click', () => msCloseAll());
buildMultiselect("msRemotePanel", "msRemoteBtn", REMOTE_OPTS, state.remoteSel, "Remote", () => { $("msRemoteBtn").innerHTML = `Remote: ${state.remoteSel.length === 1 ? (state.remoteSel[0] === "remote" ? "remote" : "on-site") : "any"} <span class="caret">${icon('chevron')}</span>`; resetAndLoad(); });

// ── On-design single-select ────────────────────────────────────────────────────────────────────────
// A native <select>'s TRIGGER can be styled, but its OPEN MENU is drawn by the OS (square, un-themable,
// foreign blue highlight) — which is what looked out of place. enhanceSelect() keeps the native <select>
// in the DOM (visually hidden) as the value source-of-truth, so every existing `.value` read, change
// listener, and dynamic option repopulation keeps working untouched; it only renders an on-design
// trigger + popup over it. A body-level observer enhances any <select> added later (query builder,
// source editor, etc.). Full keyboard + ARIA + type-ahead.
function odCloseAll(except) {
  document.querySelectorAll('.od.open').forEach((w) => {
    if (w === except) return;
    const p = w.querySelector('.od-panel'), b = w.querySelector('.od-btn');
    w.classList.remove('open'); if (p) p.classList.remove('in'); if (b) b.setAttribute('aria-expanded', 'false');
    if (p) setTimeout(() => p.classList.remove('open', 'flip'), 150);
  });
}
document.addEventListener('click', () => odCloseAll(null));
window.addEventListener('resize', () => odCloseAll(null));

// Associate each .field's visible caption with its control. The captions were rendered as bare
// <label class="hc-lab"> with no `for`, so 100 of the app's 390 controls had NO programmatic name —
// a screen reader read "edit, blank" for "Min years experience". The text is already on screen;
// this only makes the association machine-readable. Idempotent, so it can run after any render.
let fieldIdSeq = 0;
function labelFields(root = document) {
  root.querySelectorAll(".field").forEach((f) => {
    const lab = f.querySelector("label:not([for]), .hc-lab:not([for])");
    if (!lab) return;
    // Skip controls that already carry their own name: a wrapping <label>, an aria-label,
    // or a hidden file input driven by a visible button.
    const ctl = [...f.querySelectorAll("input:not([type=hidden]), textarea, select")].find(
      (c) => !c.closest("label") && !c.getAttribute("aria-label") && c.type !== "file",
    );
    if (!ctl) return;
    if (!ctl.id) ctl.id = "fld-" + (++fieldIdSeq);
    if (lab.tagName === "LABEL") lab.setAttribute("for", ctl.id);
    else ctl.setAttribute("aria-label", lab.textContent.trim().replace(/\s+/g, " ").slice(0, 80));
  });
}

let odSeq = 0; // unique ids for each combobox's listbox + options (needed by aria-activedescendant)
function enhanceSelect(sel) {
  if (!sel || sel.multiple || sel.dataset.od === '1') return;
  sel.dataset.od = '1';
  const wrap = document.createElement('span');
  wrap.className = 'od';
  const fullCtx = ['.field', '.src-fields', '.src-head', '.src-row', '.qb-cond', '.qb-val', '.qb-msval', '.ats-row'];
  if (fullCtx.some((c) => sel.closest(c)) || getComputedStyle(sel).flexGrow !== '0') wrap.classList.add('od-full');
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('od-native'); sel.setAttribute('tabindex', '-1'); sel.setAttribute('aria-hidden', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'od-btn ' + [...sel.classList].filter((c) => c !== 'od-native').join(' '); // inherit class-based width rules (.sig-monitor, .qb-field…)
  btn.setAttribute('role', 'combobox'); btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  // Accessible name. Copying only aria-label/title left 26 of the 30 comboboxes named by nothing but
  // their current VALUE — "USD, combobox", "Any time, combobox" — with no clue what they control.
  // Fall back to a real <label for>, a wrapping <label>, or the .field caption the app renders.
  const labelText = (() => {
    const direct = sel.getAttribute('aria-label') || sel.getAttribute('title');
    if (direct) return direct;
    const forLab = sel.id && document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
    if (forLab) return forLab.textContent.trim();
    const wrapLab = sel.closest('label');
    if (wrapLab) return wrapLab.textContent.trim();
    const fieldLab = sel.closest('.field')?.querySelector('label, .hc-lab, .lab');
    if (fieldLab) return fieldLab.textContent.trim();
    return "";
  })().replace(/\s+/g, " ").slice(0, 80);
  if (labelText) btn.setAttribute('aria-label', labelText);
  if (sel.dataset.tip) btn.dataset.tip = sel.dataset.tip;
  const valEl = document.createElement('span'); valEl.className = 'od-val';
  const caret = document.createElement('span'); caret.className = 'od-caret'; caret.innerHTML = icon('chevron');
  btn.append(valEl, caret);
  const panel = document.createElement('div'); panel.className = 'od-panel'; panel.setAttribute('role', 'listbox');
  const panelId = 'odp-' + (++odSeq); panel.id = panelId; btn.setAttribute('aria-controls', panelId);
  panel.addEventListener('click', (e) => e.stopPropagation());
  wrap.append(btn, panel);

  let hl = -1;
  const syncLabel = () => { const o = sel.options[sel.selectedIndex]; valEl.textContent = o ? o.textContent : ''; btn.disabled = sel.disabled; };
  const buildPanel = () => {
    panel.innerHTML = '';
    [...sel.options].forEach((o, i) => {
      const opt = document.createElement('div');
      opt.className = 'od-opt'; opt.setAttribute('role', 'option'); opt.dataset.i = i;
      opt.id = panelId + '-o' + i;
      opt.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
      opt.innerHTML = `<span class="od-ck">${icon('check')}</span><span>${esc(o.textContent)}</span>`;
      opt.addEventListener('click', () => choose(i));
      opt.addEventListener('mousemove', () => setHl(i));
      panel.appendChild(opt);
    });
  };
  const setHl = (i) => {
    hl = Math.max(0, Math.min(sel.options.length - 1, i));
    panel.querySelectorAll('.od-opt').forEach((o) => o.classList.toggle('hl', +o.dataset.i === hl));
    const a = panel.querySelector('.od-opt.hl');
    if (a) { a.scrollIntoView({ block: 'nearest' }); btn.setAttribute('aria-activedescendant', a.id); }
  };
  const choose = (i) => {
    if (i < 0 || i >= sel.options.length) return;
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    syncLabel(); close();
  };
  const open = () => {
    if (sel.disabled) return;
    odCloseAll(wrap); buildPanel(); hl = sel.selectedIndex;
    panel.classList.add('open'); wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect(), below = window.innerHeight - r.bottom, need = Math.min(300, sel.options.length * 34 + 12);
    panel.classList.toggle('flip', below < need && r.top > below);
    requestAnimationFrame(() => { panel.classList.add('in'); setHl(hl < 0 ? 0 : hl); });
  };
  const close = () => {
    panel.classList.remove('in'); wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-activedescendant');
    setTimeout(() => panel.classList.remove('open', 'flip'), 150);
    btn.focus();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.contains('open') ? close() : open(); });
  btn.addEventListener('keydown', (e) => {
    const isOpen = wrap.classList.contains('open');
    if (e.key === 'ArrowDown') { e.preventDefault(); isOpen ? setHl(hl + 1) : open(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); isOpen ? setHl(hl - 1) : open(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? choose(hl) : open(); }
    else if (e.key === 'Escape') { if (isOpen) { e.preventDefault(); close(); } }
    else if (e.key === 'Home' && isOpen) { e.preventDefault(); setHl(0); }
    else if (e.key === 'End' && isOpen) { e.preventDefault(); setHl(sel.options.length - 1); }
    else if (e.key.length === 1 && /\S/.test(e.key)) { // type-ahead
      const q = e.key.toLowerCase(), start = (isOpen ? hl : sel.selectedIndex) + 1;
      for (let k = 0; k < sel.options.length; k++) {
        const idx = (start + k) % sel.options.length;
        if ((sel.options[idx].textContent || '').trim().toLowerCase().startsWith(q)) { isOpen ? setHl(idx) : choose(idx); break; }
      }
    }
  });

  // Stay in sync when the app repopulates options or flips disabled; patch programmatic value sets too.
  new MutationObserver(() => { syncLabel(); if (wrap.classList.contains('open')) buildPanel(); })
    .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  sel.addEventListener('change', syncLabel);
  sel.addEventListener('od:refresh', syncLabel);
  odPatchSetter(sel, 'value'); odPatchSetter(sel, 'selectedIndex');
  syncLabel();
}
function odPatchSetter(el, prop) {
  if (el['_od_' + prop]) return; el['_od_' + prop] = 1;
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
  if (!desc || !desc.set) return;
  Object.defineProperty(el, prop, {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); this.dispatchEvent(new CustomEvent('od:refresh')); },
  });
}
function enhanceAllSelects(root) { (root || document).querySelectorAll('select:not([data-od])').forEach(enhanceSelect); }
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === 'SELECT') enhanceSelect(n);
    else if (n.querySelectorAll) enhanceAllSelects(n);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
enhanceAllSelects(); // initial pass over everything already in the DOM

// Type-ahead Technology quick-filter (toolbar pill). Unlike buildMultiselect's fixed options, this
// "No match in the dictionary." was printed whenever `items` came back empty — and `items` came back
// empty on ANY failure, because the fetch was wrapped in a bare `catch {}`. A request that never
// reached the server, or timed out because the engine was mid-scan, was reported to the user as a
// confident statement about the dictionary's CONTENTS. Typing "Oracle" or "SAP" — both of which the
// dictionary holds, with 40 other matches each — would intermittently say they do not exist.
//
// Intermittently is the tell, and it is what makes this worth fixing rather than shrugging at: the
// same search works a second later, so nobody suspects the request. They conclude the dictionary is
// missing things and stop trusting the picker.
//
// Now the two outcomes are told apart. fjson carries the 20s timeout and the one retry every other
// loader on this page already uses; a failure says so and offers to try again.
const TECH_LOOKUP_FAILED =
  '<div class="tech-ms-empty">Couldn\u2019t reach the dictionary just now — the engine may be busy.' +
  ' <button type="button" class="lnk" data-tech-retry>Try again</button></div>';
/** Wire the failure state's Try again button back to whatever produced it. */
function wireTechRetry(box, again) {
  const b = box.querySelector('[data-tech-retry]');
  if (b) b.onclick = again;
}
/** Ask the dictionary. Throws on failure so the caller can say so, instead of returning []. */
async function techLookup(q) {
  return (await fjson("/api/technologies?q=" + encodeURIComponent(q))).items || [];
}
// searches the 24k-technology dictionary live via /api/technologies and lets you pick several — the
// table then filters to jobs mentioning ANY of them. `sel` is a shared array of technology NAMES.
function buildTechFilter(panelId, btnId, sel, onChange) {
  const panel = $(panelId), btn = $(btnId);
  const paintBtn = () => btn.innerHTML = `Technology${sel.length ? `: <span class="badge">${sel.length}</span>` : ": any"} <span class="caret">${icon('chevron')}</span>`;
  panel.innerHTML = `<input type="search" class="tech-ms-input" aria-label="Search technologies to add" placeholder="Type a technology…" autocomplete="off"/>
    <div class="tech-ms-selected"></div><div class="tech-ms-results"></div>`;
  const input = panel.querySelector('.tech-ms-input');
  const selBox = panel.querySelector('.tech-ms-selected');
  const resBox = panel.querySelector('.tech-ms-results');
  const paintSelected = () => {
    selBox.innerHTML = sel.length ? sel.map(n => `<span class="tech-ms-chip">${esc(n)}<button type="button" data-rm="${esc(n)}" aria-label="Remove ${esc(n)}">${icon('x')}</button></span>`).join("") : "";
    selBox.querySelectorAll('[data-rm]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const n = b.dataset.rm; const i = sel.indexOf(n); if (i >= 0) sel.splice(i, 1); paintSelected(); paintBtn(); onChange(); });
  };
  const add = (name) => { if (!sel.includes(name)) sel.push(name); input.value = ""; resBox.innerHTML = ""; paintSelected(); paintBtn(); onChange(); };
  let t;
  input.oninput = () => {
    const q = input.value.trim(); clearTimeout(t);
    if (q.length < 2) { resBox.innerHTML = ""; return; }
    t = setTimeout(async () => {
      let items = [], failed = false;
      try { items = await techLookup(q); } catch { failed = true; }
      if (failed) { resBox.innerHTML = TECH_LOOKUP_FAILED; wireTechRetry(resBox, () => input.dispatchEvent(new Event("input"))); return; }
      const shown = items.filter(it => !sel.includes(it.name));
      resBox.innerHTML = shown.length ? shown.map(it => `<button type="button" class="tech-ms-opt" data-add="${esc(it.name)}"><span class="tech-ms-nm">${esc(it.name)}</span>${it.category ? `<span class="tech-ms-cat">${esc(it.category)}</span>` : ""}</button>`).join("")
        : `<div class="tech-ms-empty">No match in the dictionary.</div>`;
      resBox.querySelectorAll('[data-add]').forEach(b => b.onclick = (e) => { e.stopPropagation(); add(b.dataset.add); });
    }, 160);
  };
  panel.onclick = (e) => e.stopPropagation();
  btn.onclick = (e) => {
    e.stopPropagation();
    // Go through the SHARED msToggle. This used to be its own `classList.toggle('open')`, which
    // stopped working the moment .ms-panel gained a base `opacity: 0` that only `.in` clears — the
    // Technology dropdown still opened, occupied layout and took clicks, while being completely
    // invisible. One open/close path per component class is the fix; it also picks up the exit
    // animation, edge-flip and close-on-Escape that this copy never had.
    // A panel mid-exit still carries `open`, so msToggle correctly REOPENS it — but wasOpen was
    // true, which skipped both the viewport clamp and the search focus. On a narrow window that
    // left the panel hanging off-screen. `closing` is what tells the two apart.
    const wasOpen = panel.classList.contains("open") && !panel.classList.contains("closing");
    msToggle(panel, btn);
    panel.style.marginLeft = "";                       // reset any prior horizontal nudge
    if (!wasOpen) {
      // Keep the dropdown in-viewport regardless of where the trigger wrapped to (esp. mobile).
      // Nudge with margin, NOT transform: transform is what msToggle animates, so writing an inline
      // one here would cancel the entrance and re-break the panel in a subtler way.
      const r = panel.getBoundingClientRect();
      const over = r.right - (window.innerWidth - 8);
      if (over > 0) panel.style.marginLeft = `${-Math.min(over, Math.max(0, r.left - 8))}px`;
      setTimeout(() => input.focus(), 0);
    }
  };
  paintBtn(); paintSelected();
}

// ================= Shared hiring.cafe filter panel (dashboard editor + account check) =================
// Option vocabularies match hiring.cafe exactly (see docs/hiringcafe-contract.md).
const HCO = {
  workplaceTypes: ["Remote", "Hybrid", "Onsite", "Field"],
  commitmentTypes: ["Full Time", "Part Time", "Contract", "Internship", "Temporary", "Seasonal", "Volunteer"],
  seniorityLevels: ["No Prior Experience Required", "Entry Level", "Mid Level", "Senior Level"],
  roleTypes: ["Individual Contributor", "People Manager"],
  securityClearances: ["None", "Confidential", "Secret", "Top Secret", "Top Secret/SCI", "Public Trust", "Interim Clearances", "Other"],
  organizationTypes: ["private", "public", "non-profit", "government", "cooperative / mutual"],
  fundingStages: ["angel", "pre-seed", "seed", "series a", "series b", "series c", "series d", "series e", "series f", "series g", "series h", "series i", "crowdfunding", "private equity", "convertible note", "debt financing", "secondary market", "grant", "corporate round", "initial coin offering (ico)", "post-ipo equity", "post-ipo debt", "post-ipo secondary", "non-equity assistance", "funding round"],
  salaryFrequency: ["Hourly", "Daily", "Weekly", "Bi-Weekly", "Monthly", "Yearly"],
  companySizes: [[1, 10], [11, 50], [51, 200], [201, 500], [501, 1000], [1001, 2000], [2001, 5000], [5001, 10000], [10001, null]],
  sortBy: [["default", "Relevance"], ["date", "Most recent"], ["date_asc", "Oldest"], ["compensation_desc", "Highest salary"], ["compensation_asc", "Lowest salary"], ["experience_asc", "Least experience"], ["experience_desc", "Most experience"]],
  departments: ["Software Development","Software Engineering","Information Technology","Technology","Engineering","Data and Analytics","Product Management","Design","Quality Assurance","Quality","Project and Program Management","Business Operations","Operations","Legal and Compliance","Finance and Accounting","Finance","Accounting","Consulting Services","Retail and Wholesale","Human Resources","Administrative & Clerical Support","Sales","Marketing","Communications and Public Affairs","Business Development","Creative and Art Services","Media and Communications","Healthcare Services - Advanced Practice","Healthcare Services - Allied Health","Healthcare Services - Nursing","Healthcare Services - Pharmacy","Healthcare Services - Veterinary","Healthcare","Customer Service","Social Services","Skilled Trades - Construction","Skilled Trades - Mechanical and Electrical","Skilled Trades - Manufacturing and Industrial","Manufacturing","Skilled Trades - Maintenance and Repair","Skilled Trades - General Labor","Transportation Services","Transportation and Logistics","Supply Chain / Logistics / Procurement","Education services","Research and Development (R&D)","Research and Development","Food and Beverage Services","Protective Services","Custodial Services","Environment, Health, and Safety"],
  currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "SGD", "BRL", "MXN"],
};
const HC_LABELS = { workplaceTypes: "Workplace", commitmentTypes: "Job type", seniorityLevels: "Experience", roleTypes: "Role", departments: "Department", companySizeRanges: "Company size", organizationTypes: "Org type", fundingStages: "Funding", securityClearances: "Clearance" };
const HC_MS_FIELDS = ["workplaceTypes", "commitmentTypes", "seniorityLevels", "roleTypes", "departments", "companySizeRanges", "organizationTypes", "fundingStages", "securityClearances"];
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const sizeLabel = ([a, b]) => b == null ? `${a.toLocaleString()}+` : `${a.toLocaleString()}–${b.toLocaleString()}`;
const sizeKey = ([a, b]) => `${a}-${b == null ? "" : b}`;
const hcState = {}; // prefix -> { mode, locations:[], <field>:[] }

function hcMsOpts(field) {
  if (field === "companySizeRanges") return HCO.companySizes.map((s) => [sizeKey(s), sizeLabel(s)]);
  if (field === "fundingStages" || field === "organizationTypes") return HCO[field].map((v) => [v, titleCase(v)]);
  return HCO[field].map((v) => [v, v]);
}
function refreshMsBtn(p, f) {
  const n = hcState[p][f].length;
  $(`${p}_${f}_btn`).innerHTML = `${HC_LABELS[f]}${n ? ` <span class="badge">${n}</span>` : ""} <span class="caret">${icon('chevron')}</span>`;
}
function renderLocChips(p) {
  const box = $(p + "_locChips");
  box.innerHTML = hcState[p].locations.map((pl, i) => `<span class="hc-chip"><b>${esc(pl.formatted_address || "")}</b><button type="button" data-i="${i}" data-tip="Remove">×</button></span>`).join("");
  box.querySelectorAll("button").forEach((b) => b.onclick = () => { hcState[p].locations.splice(Number(b.dataset.i), 1); renderLocChips(p); });
}
function wireLocationAc(p) {
  const inp = $(p + "_locInput"), menu = $(p + "_locMenu"); let t, items = [];
  inp.oninput = () => {
    clearTimeout(t); const q = inp.value.trim();
    if (q.length < 2) { menu.classList.remove("open"); return; }
    t = setTimeout(async () => {
      try {
        const d = await (await fetch("/api/location-autocomplete?q=" + encodeURIComponent(q))).json();
        items = d.items || [];
        menu.innerHTML = items.length ? items.map((it, i) => `<div class="hc-ac-item" data-i="${i}">${esc(it.label)}</div>`).join("") : `<div class="hc-ac-item" style="color:var(--faint)">No matches</div>`;
        menu.classList.add("open");
        menu.querySelectorAll(".hc-ac-item[data-i]").forEach((el) => el.onclick = () => {
          const it = items[Number(el.dataset.i)];
          if (it?.place) { hcState[p].locations.push(it.place); renderLocChips(p); }
          inp.value = ""; menu.classList.remove("open");
        });
      } catch { menu.classList.remove("open"); }
    }, 220);
  };
  inp.onblur = () => setTimeout(() => menu.classList.remove("open"), 200);
}
// Industry is the one filter vocabulary that is NOT a closed list — hiring.cafe's field is
// open-ended (841 distinct values across our stored rows, long tail), so a dropdown would be the
// wrong control and would imply the options are exhaustive. This is free text with SUGGESTIONS: type
// anything and press Enter, or pick a hint drawn from industries we have actually seen. The menu says
// which it is, so nobody reads the hints as the complete set.
function renderIndChips(p) {
  const box = $(p + "_indChips"); if (!box) return;
  box.innerHTML = (hcState[p].industries || []).map((v, i) =>
    `<span class="hc-chip"><b>${esc(v)}</b><button type="button" data-i="${i}" data-tip="Remove">×</button></span>`).join("");
  box.querySelectorAll("button[data-i]").forEach((b) => b.onclick = () => {
    hcState[p].industries.splice(Number(b.dataset.i), 1); renderIndChips(p);
  });
}
function wireIndustryAc(p) {
  const inp = $(p + "_indInput"), menu = $(p + "_indMenu");
  if (!inp || !menu) return;
  let t, items = [];
  const add = (v) => {
    const name = String(v ?? "").trim();
    if (!name) return;
    const cur = hcState[p].industries ||= [];
    if (!cur.some((x) => x.toLowerCase() === name.toLowerCase())) cur.push(name);
    renderIndChips(p); inp.value = ""; menu.classList.remove("open");
  };
  inp.oninput = () => {
    clearTimeout(t); const q = inp.value.trim();
    if (!q) { menu.classList.remove("open"); return; }
    t = setTimeout(async () => {
      try {
        const d = await fjson("/api/industries?limit=12&q=" + encodeURIComponent(q));
        items = d.items || [];
        const more = (d.matched || 0) - items.length;
        menu.innerHTML = (items.length
          ? items.map((it, i) => `<div class="hc-ac-item" data-i="${i}">${esc(it.name)} <span class="hint">${fmtNum(it.jobs)} job${it.jobs === 1 ? "" : "s"} seen</span></div>`).join("")
            + (more > 0 ? `<div class="hc-ac-item" style="color:var(--faint)">…and ${fmtNum(more)} more — keep typing, or press Enter to use exactly what you typed</div>` : "")
          : `<div class="hc-ac-item" style="color:var(--faint)">No industry we've seen matches — press Enter to use it anyway</div>`);
        menu.classList.add("open");
        menu.querySelectorAll(".hc-ac-item[data-i]").forEach((el) => el.onclick = () => add(items[Number(el.dataset.i)]?.name));
      } catch { menu.classList.remove("open"); }   // suggestions are a convenience; typing still works
    }, 220);
  };
  // Enter accepts what was TYPED, not the first suggestion — the field's whole point is that the
  // vocabulary is open and a value we have never seen is still a valid filter.
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(inp.value); } };
  inp.onblur = () => setTimeout(() => menu.classList.remove("open"), 200);
}
function renderHcFilters(p, opts = {}) {
  hcState[p] = { mode: "corporate", locations: [], industries: [], workplaceTypes: [], commitmentTypes: [], seniorityLevels: [], departments: [], roleTypes: [], fundingStages: [], securityClearances: [], organizationTypes: [], companySizeRanges: [] };
  const showCoverage = opts.coverage !== false; // hidden for domain-only panels (account check has no local tier)
  // A domain-only panel scans /org/<domain>, which takes no filter parameters — every filter it shows
  // is re-applied locally from the facts each job carries (src/orgFacets.ts). "Role" is the one that
  // cannot be: hiring.cafe records Individual Contributor / People Manager on the SEARCH, never on the
  // job, so there is nothing on the row to compare against. A control that silently cannot work is
  // worse than no control, so this panel does not offer it.
  const skip = new Set(opts.domainOnly ? ["roleTypes"] : []);
  const ms = (field) => skip.has(field) ? "" : `<div class="field hc-ms"><label class="hc-lab">${HC_LABELS[field]}</label><div class="ms"><button type="button" class="pill ms-btn" id="${p}_${field}_btn">${HC_LABELS[field]} <span class="caret">${icon('chevron')}</span></button><div class="ms-panel" id="${p}_${field}_panel"></div></div></div>`;
  $(p + "Filters").innerHTML = `
    ${showCoverage ? `<div class="hc-sec">Coverage</div>
    <div class="hc-mode" id="${p}_mode">
      <button type="button" data-v="corporate" class="active">Companies</button>
      <button type="button" data-v="corporate_local">+ Local businesses</button>
    </div>
    <div class="hc-note"><b>Companies</b> covers employers of every size with the full filter set below. <b>+ Local businesses</b> also surfaces small and local businesses (matched on keyword + location only).</div>` : ""}
    <div class="hc-sec">Location</div>
    <div class="field hc-ac">
      <input type="text" id="${p}_locInput" aria-label="Add a location" placeholder="Type a city, state, or country…" autocomplete="off" />
      <div class="hc-ac-menu" id="${p}_locMenu"></div>
      <div class="hc-chips" id="${p}_locChips"></div>
    </div>
    <div class="hc-sec">Role &amp; workplace</div>
    <div class="hc-grid">
      ${ms("workplaceTypes")}${ms("commitmentTypes")}${ms("seniorityLevels")}${ms("roleTypes")}${ms("departments")}
      <div class="field"><label class="hc-lab">Posted within</label><select id="${p}_date"><option value="0">Any time</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="90">90 days</option></select></div>
    </div>
    <div class="hc-grid narrow">
      <div class="field"><label class="hc-lab">Min years experience</label><input type="number" id="${p}_yoeMin" min="0" max="20" placeholder="any" /></div>
      <div class="field"><label class="hc-lab">Max years experience</label><input type="number" id="${p}_yoeMax" min="0" max="20" placeholder="any" /></div>
    </div>
    <label class="check" style="margin-top:6px"><input type="checkbox" id="${p}_yoeStated" /> Only jobs that state the experience required</label>
    <div class="hc-sec">Compensation</div>
    <div class="hc-grid narrow">
      <div class="field"><label class="hc-lab">Min salary</label><input type="number" id="${p}_salMin" min="0" placeholder="any" /></div>
      <div class="field"><label class="hc-lab">Max salary</label><input type="number" id="${p}_salMax" min="0" placeholder="any" /></div>
      <div class="field"><label class="hc-lab">Currency</label><select id="${p}_cur">${HCO.currencies.map((c) => `<option>${c}</option>`).join("")}</select></div>
      <div class="field"><label class="hc-lab">Pay period</label><select id="${p}_freq">${HCO.salaryFrequency.map((f) => `<option ${f === "Yearly" ? "selected" : ""}>${f}</option>`).join("")}</select></div>
    </div>
    <label class="check" style="margin-top:6px"><input type="checkbox" id="${p}_transparent" /> Only jobs with a published salary</label>
    <div class="hc-sec">Company</div>
    <div class="hc-grid">
      ${ms("companySizeRanges")}${ms("organizationTypes")}${ms("fundingStages")}${ms("securityClearances")}
    </div>
    <div class="field hc-ac" style="margin-top:8px">
      <label class="hc-lab">Industry <span class="hint">type any industry — suggestions come from what we've seen</span></label>
      <input type="text" id="${p}_indInput" aria-label="Add an industry" placeholder="e.g. Logistics, Fintech, Cybersecurity…" autocomplete="off" />
      <div class="hc-ac-menu" id="${p}_indMenu"></div>
      <div class="hc-chips" id="${p}_indChips"></div>
    </div>
    <div class="hc-grid narrow">
      <div class="field"><label class="hc-lab">Founded after</label><input type="number" id="${p}_yrMin" min="1800" max="2030" placeholder="any" /></div>
      <div class="field"><label class="hc-lab">Founded before</label><input type="number" id="${p}_yrMax" min="1800" max="2030" placeholder="any" /></div>
    </div>
    ${opts.domainOnly ? "" : `<div class="hc-sec">Sort</div>
    <div class="field"><label class="hc-lab">Order results by</label><select id="${p}_sort">${HCO.sortBy.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>`}
  `;
  if (showCoverage) $(p + "_mode").querySelectorAll("button").forEach((b) => b.onclick = () => { hcState[p].mode = b.dataset.v; $(p + "_mode").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); });
  for (const f of HC_MS_FIELDS) { if (skip.has(f)) continue; buildMultiselect(`${p}_${f}_panel`, `${p}_${f}_btn`, hcMsOpts(f), hcState[p][f], HC_LABELS[f], () => refreshMsBtn(p, f)); refreshMsBtn(p, f); }
  wireLocationAc(p);
  wireIndustryAc(p); renderIndChips(p);
}
function collectHcFilters(p) {
  const st = hcState[p];
  const num = (id) => { const v = $(p + "_" + id).value.trim(); return v === "" ? null : Number(v); };
  const sizes = st.companySizeRanges.map((k) => { const [a, b] = k.split("-"); return [Number(a), b === "" ? null : Number(b)]; });
  return {
    sourceMode: st.mode, locations: st.locations.slice(),
    workplaceTypes: st.workplaceTypes.slice(), commitmentTypes: st.commitmentTypes.slice(),
    seniorityLevels: st.seniorityLevels.slice(), departments: st.departments.slice(),
    roleTypes: st.roleTypes.slice(), organizationTypes: st.organizationTypes.slice(),
    fundingStages: st.fundingStages.slice(), securityClearances: st.securityClearances.slice(),
    companySizeRanges: sizes,
    industries: (st.industries || []).slice(),
    yoeMin: num("yoeMin"), yoeMax: num("yoeMax"),
    // hiring.cafe calls this excludeIfRoleYoeIsNotSpecified and only honours it alongside a bound;
    // orgFacets applies the same rule locally. It had no control at all — settable only in a YAML.
    excludeIfNoYoe: $(p + "_yoeStated").checked,
    salaryMin: num("salMin"), salaryMax: num("salMax"),
    salaryCurrency: $(p + "_cur").value, salaryFrequency: $(p + "_freq").value,
    onlyTransparentSalary: $(p + "_transparent").checked,
    minYearFounded: num("yrMin"), maxYearFounded: num("yrMax"),
    datePostedDays: Number($(p + "_date").value) || 0,
    // absent on a domain-only panel: sortBy orders a hiring.cafe SEARCH, and /org/ is not a search.
    sortBy: $(p + "_sort")?.value ?? "default",
  };
}
function fillHcFilters(p, s) {
  s = s || {}; const st = hcState[p];
  st.mode = s.sourceMode || "corporate";
  const modeEl = $(p + "_mode"); // absent on domain-only panels (coverage hidden)
  if (modeEl) modeEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === st.mode));
  st.locations = Array.isArray(s.locations) ? s.locations.slice() : []; renderLocChips(p);
  st.industries = Array.isArray(s.industries) ? s.industries.slice() : []; renderIndChips(p);
  const arrs = { workplaceTypes: s.workplaceTypes, commitmentTypes: s.commitmentTypes, seniorityLevels: s.seniorityLevels, departments: s.departments, roleTypes: s.roleTypes, organizationTypes: s.organizationTypes, fundingStages: s.fundingStages, securityClearances: s.securityClearances };
  // A domain-only panel omits controls it cannot honour (see renderHcFilters), so the elements are
  // not there to fill. Skipping them keeps the stored value intact rather than throwing mid-render.
  for (const [f, arr] of Object.entries(arrs)) { st[f] = (arr || []).slice(); if (!$(`${p}_${f}_btn`)) continue; buildMultiselect(`${p}_${f}_panel`, `${p}_${f}_btn`, hcMsOpts(f), st[f], HC_LABELS[f], () => refreshMsBtn(p, f)); refreshMsBtn(p, f); }
  st.companySizeRanges = (s.companySizeRanges || []).map((t) => `${t[0]}-${t[1] == null ? "" : t[1]}`);
  buildMultiselect(`${p}_companySizeRanges_panel`, `${p}_companySizeRanges_btn`, hcMsOpts("companySizeRanges"), st.companySizeRanges, "Company size", () => refreshMsBtn(p, "companySizeRanges")); refreshMsBtn(p, "companySizeRanges");
  const setv = (id, v) => { $(p + "_" + id).value = v == null ? "" : v; };
  setv("yoeMin", s.yoeMin); setv("yoeMax", s.yoeMax); setv("salMin", s.salaryMin); setv("salMax", s.salaryMax);
  $(p + "_cur").value = s.salaryCurrency || "USD"; $(p + "_freq").value = s.salaryFrequency || "Yearly";
  $(p + "_transparent").checked = !!s.onlyTransparentSalary;
  $(p + "_yoeStated").checked = !!s.excludeIfNoYoe;
  setv("yrMin", s.minYearFounded); setv("yrMax", s.maxYearFounded);
  $(p + "_date").value = String(s.datePostedDays || 0);
  const sortEl = $(p + "_sort"); if (sortEl) sortEl.value = s.sortBy || "default";
}
renderHcFilters("f");
renderHcFilters("ac", { coverage: false, domainOnly: true }); // /org/ scan — no coverage toggle, and no Role filter (not on the job)
// Account Check now carries the same keyword/technology power as a monitor (closes the gap where a
// one-off check could not filter by technology). acTechSel is read on Run check.
let acTechSel = [];
buildTechPicker("acTechPicker", acTechSel);

// ---- Fetch New Jobs (background trigger) + next-fetch countdown + global activity feed ----
let cooldownTimer = null, nextFetchTimer = null;
async function refreshFetchStatus() {
  if (!state.client) { paintNextFetch(null); return; }
  try {
    const s = await (await fetch(`/api/clients/${encodeURIComponent(state.client)}/fetch-status`)).json();
    paintFetchBtn(s.inProgress, s.cooldownMs);
    paintNextFetch(s.nextFetchAt || null);
  } catch {
    // startFetch disables the button and sets "Starting…", then relies on ITS catch calling this
    // function to put the label back. Swallowing the error here meant the same outage that failed
    // the POST also failed this GET, so paintFetchBtn never ran and the primary action of the
    // monitor views stayed disabled and stuck on "Starting…" until a reload.
    paintFetchBtn(false, 0);
    paintNextFetch(null);
  }
}
// Live "next auto-fetch in …" countdown for the selected client (server returns the next cron fire time).
function paintNextFetch(at) {
  clearInterval(nextFetchTimer);
  const el = $("nextFetch"); if (!el) return;
  if (!at || !state.client) { el.textContent = ""; el.style.display = "none"; return; }
  el.style.display = "";
  const tick = () => {
    const ms = at - Date.now();
    if (ms <= 0) { el.innerHTML = `${icon('clock')} auto-fetch due…`; return; }
    const totalMin = Math.floor(ms / 60000), h = Math.floor(totalMin / 60), m = totalMin % 60, s = Math.floor((ms % 60000) / 1000);
    const txt = h > 0 ? `${h}h ${m}m` : totalMin > 0 ? `${m}m ${s}s` : `${s}s`;
    el.innerHTML = `${icon('clock')} next auto-fetch in <b>${txt}</b>`;
  };
  tick(); nextFetchTimer = setInterval(tick, 1000);
}
function paintFetchBtn(running, cooldownMs) {
  const btn = $("fetchBtn");
  const stopBtn = $("stopFetchBtn");
  clearInterval(cooldownTimer);
  // The Stop button only exists while a fetch is in flight — it shares the fetch button's slot in
  // the toolbar rather than sitting there greyed-out when there is nothing to stop.
  if (stopBtn) { stopBtn.hidden = !running; if (running) { stopBtn.disabled = false; stopBtn.textContent = "Stop"; } }
  if (running) { btn.disabled = true; btn.textContent = "Fetching…"; return; }
  btn.disabled = !state.client;
  if (cooldownMs > 0) {
    const tick = () => {
      const left = Math.max(0, cooldownMs - (Date.now() - start));
      const s = Math.ceil(left / 1000);
      btn.textContent = `Fetch (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
      if (left <= 0) { clearInterval(cooldownTimer); btn.textContent = "Fetch New Jobs"; }
    };
    const start = Date.now();
    tick(); cooldownTimer = setInterval(tick, 1000);
  } else btn.textContent = "Fetch New Jobs";
}
// Manual trigger — the run happens server-side; progress shows via the activity feed (below).
async function startFetch(override) {
  if (!state.client) return;
  const btn = $("fetchBtn"); btn.disabled = true; btn.textContent = "Starting…";
  try {
    const r = await (await fetch(`/api/clients/${encodeURIComponent(state.client)}/fetch?override=${override ? 1 : 0}`, { method: "POST" })).json();
    if (r.cooldown) {
      const sec = Math.ceil(r.cooldownMs / 1000);
      if (await uiConfirm(`This client was fetched recently (cooldown ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} left).\n\nFetching again now may trip hiring.cafe rate limits. Fetch anyway?`, { title: "Fetch again?", confirmLabel: "Fetch anyway" })) return startFetch(true);
      return refreshFetchStatus();
    }
    if (r.running) { toast("A fetch is already running for this client."); return refreshFetchStatus(); }
    btn.textContent = "Fetching…"; // the activity feed renders progress from here
  } catch (e) { toast("Couldn't start fetch: " + e.message, true); refreshFetchStatus(); }
}
$("fetchBtn").onclick = () => startFetch(false);

// Stop the in-flight fetch gracefully. The run keeps going server-side until its current step ends,
// so the button reads "Stopping…" until the activity feed reports the run done and re-syncs the toolbar.
async function stopFetch() {
  if (!state.client) return;
  const stopBtn = $("stopFetchBtn");
  stopBtn.disabled = true; stopBtn.textContent = "Stopping…";
  const ok = await mutate(`/api/clients/${encodeURIComponent(state.client)}/stop-fetch`, { method: "POST" }, "Could not stop the fetch");
  if (!ok) { stopBtn.disabled = false; stopBtn.textContent = "Stop"; return; }
  // If nothing was actually running the feed won't send a "done", so re-sync the toolbar ourselves.
  refreshFetchStatus();
}
$("stopFetchBtn").onclick = stopFetch;

// ---- Toast notifications ----
// The live region is created ONCE, at load, not lazily inside the call that inserts the first
// message. A screen reader only announces changes to a region it was already observing, so
// creating the container and its first child in the same synchronous block meant the first toast
// of every session — often the one reporting that something failed — was silently dropped.
// Two regions, because politeness is per-region: successes wait their turn, errors interrupt.
function liveRegion(assertive) {
  // One fixed stack holds both regions, so two position:fixed containers cannot land on top of each
  // other in the same corner. Errors sit above successes.
  let stack = document.getElementById("toastStack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toastStack"; stack.className = "toasts";
    document.body.appendChild(stack);
  }
  const id = assertive ? "toastsErr" : "toasts";
  let c = document.getElementById(id);
  if (!c) {
    c = document.createElement("div");
    c.id = id; c.className = "toast-region";
    c.setAttribute("role", assertive ? "alert" : "status");
    c.setAttribute("aria-live", assertive ? "assertive" : "polite");
    // Errors first in DOM order = visually on top of the successes below them.
    if (assertive) stack.prepend(c); else stack.appendChild(c);
  }
  return c;
}
liveRegion(false); liveRegion(true);   // observed from load, before anything writes to them

function toast(msg, isErr) {
  const c = liveRegion(!!isErr);
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.innerHTML = `<span class="ti">${icon(isErr ? "x" : "check")}</span><span>${esc(msg)}</span>`;
  c.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, 6000);
}

// ---- On-design confirm / alert dialogs (replace native confirm()/alert() everywhere) ----
// uiConfirm(msg, {title, confirmLabel, danger}) → Promise<boolean>; uiAlert(msg, {title}) → Promise<void>.
// Portal-rendered modal with keyboard support (Enter = confirm, Esc = cancel) and reduced-motion-safe CSS.
let cfmSeq = 0; // unique ids so each dialog's body can be aria-describedby its own container
// Keep Tab inside an open modal. Without this, Tab walks straight out of the dialog into the page
// behind it — the user keeps typing into a form they can no longer see.
function cfmTrap(e, bg) {
  const f = [...bg.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function uiDialog(msg, { title = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false, alertOnly = false } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "cfm-bg";
    const msgId = "cfm-msg-" + (++cfmSeq);   // the body text must be ANNOUNCED, not just the title
    bg.innerHTML = `
      <div class="cfm" role="${alertOnly ? "alertdialog" : "dialog"}" aria-modal="true" aria-describedby="${msgId}" aria-label="${esc(title || (alertOnly ? "Notice" : "Confirm"))}">
        ${title ? `<div class="cfm-title">${esc(title)}</div>` : ""}
        <div class="cfm-msg" id="${msgId}">${esc(msg).replace(/\n/g, "<br>")}</div>
        <div class="cfm-actions">
          ${alertOnly ? "" : `<button class="btn ghost cfm-cancel" type="button">${esc(cancelLabel)}</button>`}
          <button class="btn ${danger ? "danger" : "primary"} cfm-ok" type="button">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const opener = document.activeElement;   // put focus back where it came from
    const done = (v) => {
      bg.classList.remove("in");
      setTimeout(() => bg.remove(), 160);
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(!alertOnly ? false : undefined); }
      if (e.key === "Enter") {
        // Never hijack Enter while a button has focus — a focused button must activate ITSELF.
        // This ran done(true) for EVERY Enter regardless of focus, in the capture phase with
        // preventDefault + stopPropagation, so a focused Cancel never got its own activation and
        // the keyboard-natural way to back out of a destructive confirm performed the deletion.
        const a = document.activeElement;
        const onButton = a && bg.contains(a) && a.tagName === "BUTTON";
        if (!onButton) { e.preventDefault(); e.stopPropagation(); done(true); }
      }
      if (e.key === "Tab") cfmTrap(e, bg);   // a modal must not let Tab wander into the page behind it
    };
    bg.addEventListener("mousedown", (e) => { if (e.target === bg && !alertOnly) done(false); });
    bg.querySelector(".cfm-ok").onclick = () => done(true);
    const c = bg.querySelector(".cfm-cancel"); if (c) c.onclick = () => done(false);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add("in"));
    // Focus is a correctness contract, not decoration — don't gate it on a frame callback,
    // which a background/unfocused window can defer indefinitely.
    // A DANGER dialog focuses Cancel, not the destructive button: the pre-selected action of a
    // destructive confirm must be the safe one, so Enter-on-open can never delete.
    setTimeout(() => {
      if (!document.contains(bg)) return;
      ((danger && bg.querySelector(".cfm-cancel")) || bg.querySelector(".cfm-ok")).focus();
    }, 0);
  });
}
const uiConfirm = (msg, opts = {}) => uiDialog(msg, { confirmLabel: opts.confirmLabel || "Confirm", ...opts });
const uiAlert = (msg, opts = {}) => uiDialog(msg, { ...opts, alertOnly: true }).then(() => undefined);
// On-design text prompt → resolves to the entered string, or null on cancel.
function uiPrompt(msg, { title = "", placeholder = "", confirmLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement("div"); bg.className = "cfm-bg";
    const msgId = "cfm-msg-" + (++cfmSeq);
    const opener = document.activeElement;
    bg.innerHTML = `
      <div class="cfm" role="dialog" aria-modal="true" aria-describedby="${msgId}" aria-label="${esc(title || msg)}">
        ${title ? `<div class="cfm-title">${esc(title)}</div>` : ""}
        <div class="cfm-msg" id="${msgId}">${esc(msg)}</div>
        <input class="cfm-input" type="text" aria-label="${esc(msg)}" placeholder="${esc(placeholder)}" />
        <div class="cfm-actions">
          <button class="btn ghost cfm-cancel" type="button">Cancel</button>
          <button class="btn primary cfm-ok" type="button">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const inp = bg.querySelector(".cfm-input");
    const done = (v) => { bg.classList.remove("in"); setTimeout(() => bg.remove(), 160); document.removeEventListener("keydown", onKey, true); if (opener && document.contains(opener)) opener.focus?.(); resolve(v); };
    // Same contract as uiDialog: Enter submits from the text field (expected), but a focused button
    // activates itself — otherwise Enter on Cancel saves.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      if (e.key === "Enter") {
        const a = document.activeElement;
        if (!(a && bg.contains(a) && a.tagName === "BUTTON")) { e.preventDefault(); done(inp.value || null); }
      }
      if (e.key === "Tab") cfmTrap(e, bg);
    };
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) done(null); });
    bg.querySelector(".cfm-ok").onclick = () => done(inp.value || null);
    bg.querySelector(".cfm-cancel").onclick = () => done(null);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add("in"));
    setTimeout(() => { if (document.contains(bg)) inp.focus(); }, 0);
  });
}

// ---- Fetch activity: progress for EVERY fetch (Client Monitoring, Account Monitoring, Account Checking).
//      A fetch shows PROMINENTLY (the big in-view bar, or the account-check detail view) only on its OWN
//      screen; everywhere else it lives in the top-right "active fetches" dock, labelled by type, so it
//      never intrudes on an unrelated view. One feed, connected once on load. ----
const activeFetches = new Map(); // key -> latest running FetchActivity (removed on done/error)
let fetchHideTimer = null;
// Each activity now carries its own kind (no CONFIGS lookup needed; works for account checks too).
const kindLabel = (a) => a.kind === "watchlist" ? "Account Monitoring" : a.kind === "account-check" ? "Account Checking"
  : a.kind === "signal-check" ? "Signal Check" : "Client Monitoring";
const unitNoun = (a) => a.kind === "search" ? "sources" : "accounts";
const acIdOf = (a) => (typeof a.key === "string" && a.key.startsWith("ac:")) ? a.key.slice(3) : null;
// Does a fetch belong to the big monitor bar (#fetchwrap) on the screen you're on? Monitoring kinds only:
// you're in that monitoring view, same kind, on its tab or the combined "All" tab. (Account checks never
// use #fetchwrap — they have their own progress in the detail view.)
function inFetchwrapScope(a) {
  if (a.kind === "account-check") return false;
  if (state.view !== "clients" && state.view !== "accounts") return false;
  if (a.kind !== state.kind) return false;
  return state.client === "" || state.client === a.client;
}
// Is this fetch already shown prominently somewhere on the current screen (so the dock should omit it)?
function prominentlyShown(a) {
  if (inFetchwrapScope(a)) return true;
  if (a.kind === "account-check") return state.view === "checking" && acDetail && acDetail.id === acIdOf(a); // its own detail view
  return false;
}
function paintProminent(a, done) {
  const wrap = $("fetchwrap"); wrap.classList.add("show");
  const pct = a.total ? Math.round((a.completed / a.total) * 100) : (done ? 100 : 8);
  $("fpBar").style.width = Math.max(pct, done ? 100 : 6) + "%";
  $("fpStatus").textContent = done ? `Done — ${a.client}` : a.phase === "error" ? `Error — ${a.client}` : `Fetching ${a.client}…`;
  $("fpNums").textContent = a.total ? `${fmtNum(a.completed)}/${fmtNum(a.total)} ${unitNoun(a)}` : "";
  // A run can spend a long time in a phase that fetches nothing — a watchlist checks every watched
  // company for a job board before it fetches a single posting, which on a cold cache is ~4 companies
  // a second. For a 7,470-company list that is around half an hour of "0 new jobs found · 0 matched",
  // which is exactly what a hung process looks like. When the server sends a note, the note answers
  // the question the reader is actually asking; the zeroes answer nothing.
  $("fpCount").innerHTML = !done && a.note
    ? esc(a.note)
    : `<b>${fmtNum(a.fresh || 0)}</b> new job${(a.fresh || 0) === 1 ? "" : "s"} found · ${fmtNum(a.matched || 0)} matched`;
}
// The in-#fetchwrap-scope running fetch (latest if several) — the monitoring fetch that "owns" this screen.
function pickInScope() {
  let pick = null;
  for (const a of activeFetches.values()) if (inFetchwrapScope(a) && (!pick || a.startedAt >= pick.startedAt)) pick = a;
  return pick;
}
// Show the prominent bar only for the in-scope RUNNING monitoring fetch. A done-flash is handled separately.
function renderProminentFetch() {
  if (fetchHideTimer) return; // a done-flash is currently lingering; let it finish
  const pick = pickInScope();
  if (pick) paintProminent(pick, false);
  else $("fetchwrap").classList.remove("show");
}
// Top-right dock: the fetches happening ELSEWHERE — every active fetch EXCEPT those already shown
// prominently on this screen. Each item is labelled with its type and links to its own view.
function renderFetchDock() {
  const dock = $("fetchDock"); if (!dock) return;
  const list = [...activeFetches.values()].filter((a) => !prominentlyShown(a)).sort((a, b) => a.startedAt - b.startedAt);
  if (!list.length) { dock.hidden = true; $("fdPanel").hidden = true; return; }
  dock.hidden = false;
  $("fdLabel").textContent = `${list.length} fetch${list.length === 1 ? "" : "es"} running`;
  $("fdList").innerHTML = list.map((a) => {
    const pct = a.total ? Math.min(100, Math.round((a.completed / a.total) * 100)) : 6;
    return `<button type="button" class="fd-item" data-key="${esc(a.key)}">
      <div class="fd-item-top"><span class="fd-name">${esc(a.client)}</span><span class="fd-pct">${a.total ? pct + "%" : "…"}</span></div>
      <div class="fd-kind k-${a.kind}">${kindLabel(a)}</div>
      <div class="fd-bar"><div style="width:${Math.max(pct, 4)}%"></div></div>
      <div class="fd-sub">${a.note ? esc(a.note)
        : `${a.total ? `${fmtNum(a.completed)}/${fmtNum(a.total)} ${unitNoun(a)}` : "starting…"} · <b>${fmtNum(a.fresh || 0)}</b> ${a.kind === "account-check" ? "found" : "new"}`}</div>
    </button>`;
  }).join("");
  // Click a dock item → jump to that fetch's own view/tab/detail (where it shows prominently).
  $("fdList").querySelectorAll(".fd-item").forEach((b) => b.onclick = () => { const a = activeFetches.get(b.dataset.key); if (a) jumpToFetch(a); $("fdPanel").hidden = true; });
}
// Navigate to the view + tab/detail that owns a fetch, so its prominent progress is visible.
function jumpToFetch(a) {
  if (a.kind === "account-check") {
    const id = acIdOf(a);
    if (state.view !== "checking") showView("checking");
    if (id) acOpenDetail(id);
    return;
  }
  const view = a.kind === "watchlist" ? "accounts" : "clients";
  if (state.view !== view) showView(view);
  selectClient(a.client);
}
function upsertActive(a) {
  if (a.phase === "done" || a.phase === "error") activeFetches.delete(a.key);
  else activeFetches.set(a.key, a);
}
function connectActivity() {
  const es = new EventSource("/api/activity");
  const onLive = (a) => { upsertActive(a); renderProminentFetch(); renderFetchDock(); };
  es.addEventListener("snapshot", (e) => { (JSON.parse(e.data).active || []).forEach(upsertActive); renderProminentFetch(); renderFetchDock(); });
  es.addEventListener("start", (e) => onLive(JSON.parse(e.data)));
  es.addEventListener("progress", (e) => onLive(JSON.parse(e.data)));
  es.addEventListener("done", (e) => {
    const a = JSON.parse(e.data);
    activeFetches.delete(a.key);
    // Flash the completion in the prominent monitor bar only if you're on its view, then clear after a beat.
    if (inFetchwrapScope(a)) { clearTimeout(fetchHideTimer); paintProminent(a, true); fetchHideTimer = setTimeout(() => { fetchHideTimer = null; renderProminentFetch(); }, 6000); }
    renderFetchDock();
    const stoppedNote = a.stopped ? " (stopped early — partial results kept)" : "";
    if (a.phase === "error") toast(`Fetch failed for "${a.client}": ${a.error || "error"}`, true);
    else if (a.kind === "account-check") toast(`"${a.client}" — ${fmtNum(a.fresh || 0)} matching role${(a.fresh || 0) === 1 ? "" : "s"} found${stoppedNote}`);
    else toast(`"${a.client}" — ${fmtNum(a.fresh || 0)} new job${(a.fresh || 0) === 1 ? "" : "s"} found, ${fmtNum(a.matched || 0)} matched${stoppedNote}`);
    if (a.kind !== "account-check") { // account checks update their own detail view via its SSE
      loadConfig(); loadStats();
      // loadMatches() ends with markSeen(), which advances the "last looked at" watermark and zeroes
      // the sidebar NEW badge. So it may only run when the user is ACTUALLY LOOKING at a matches
      // table for this fetch's scope. Without the view check, any scheduled fetch that landed while
      // the user sat on Home/Signals/Jobs marked its own results as already-seen and the "what
      // arrived since I last looked" affordance reported 0 with unseen matches sitting there. The
      // kind check matters too: scope "All" is per-tab, so a watchlist fetch must not clear the
      // Client Monitoring badge. (Two lines below already guard on state.view; this one did not.)
      // …and only from the POSTINGS sub-tab. loadMatches ends in markSeen(), which advances the
      // "last looked at" watermark — but on the Companies sub-tab the postings table is not even
      // rendered, so the badge was cleared for matches the user never saw. state.postTab is the
      // missing half of "is the user actually looking at this".
      const viewingMatches = (state.view === "clients" || state.view === "accounts") && state.postTab !== "companies";
      const sameKind = (a.kind === "watchlist") === (state.kind === "watchlist");
      if (viewingMatches && sameKind && (state.client === "" || a.client === state.client)) loadMatches({ background: true });
      if (a.client === state.client) refreshFetchStatus();
    }
    refreshUnseenBadges(); // a completed fetch may have added unseen matches → update the sidebar NEW badges
    if (a.phase !== "error") maybeNotify(a); // desktop notification when new matches land in the background
    if (state.view === "system") loadSystem({ background: true }); // refresh the run history if it's open
  });
}
// Dock open/close (app.js runs at end of body, so the elements exist)
$("fdBtn").onclick = (e) => { e.stopPropagation(); const p = $("fdPanel"); p.hidden = !p.hidden; };
$("fdPanel").onclick = (e) => e.stopPropagation();
document.addEventListener("click", () => { $("fdPanel").hidden = true; });

// ---- Client editor (slide-over) ----
let editingName = null, editingConfig = null;
const NEW_DEFAULT = {
  name: "", active: true,
  search: { keywords: [], exclude: [], excludeCompanies: [], sourceMode: "corporate", locations: [],
    workplaceTypes: [], commitmentTypes: [], seniorityLevels: [], departments: [], datePostedDays: 0, searchDepth: "deep", sortBy: "default" },
  delivery: { webhook_url: "", mode: "realtime" }
};
const lines = (id) => $(id).value.split(/\n+/).map(s => s.trim()).filter(Boolean);
const showMsg = (text, isErr) => { const m = $("drawerMsg"); m.textContent = text; m.className = "msg " + (isErr ? "err" : "ok"); };

// Inline technology picker used inside the search + watchlist editors: a type-ahead over the 24k
// dictionary that writes selected NAMES into `sel` (mutated in place, read on save). Always-visible
// (search box + chips), unlike the toolbar pill's dropdown.
function buildTechPicker(containerId, sel) {
  const box = $(containerId); if (!box) return;
  box.innerHTML = `<input type="search" class="tech-pick-input" placeholder="Type a technology — e.g. React, Kubernetes…" autocomplete="off"/>
    <div class="tech-pick-chips"></div><div class="tech-pick-results"></div>`;
  const input = box.querySelector('.tech-pick-input'), chips = box.querySelector('.tech-pick-chips'), results = box.querySelector('.tech-pick-results');
  const paintChips = () => {
    chips.innerHTML = sel.map(n => `<span class="tech-ms-chip">${esc(n)}<button type="button" data-rm="${esc(n)}" aria-label="Remove ${esc(n)}">${icon('x')}</button></span>`).join("");
    chips.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const i = sel.indexOf(b.dataset.rm); if (i >= 0) sel.splice(i, 1); paintChips(); });
  };
  const add = (name) => { if (!sel.includes(name)) sel.push(name); input.value = ""; results.innerHTML = ""; paintChips(); };
  let t;
  input.oninput = () => {
    const q = input.value.trim(); clearTimeout(t);
    if (q.length < 2) { results.innerHTML = ""; return; }
    t = setTimeout(async () => {
      let items = [], failed = false;
      try { items = await techLookup(q); } catch { failed = true; }
      if (failed) { results.innerHTML = TECH_LOOKUP_FAILED; wireTechRetry(results, () => input.dispatchEvent(new Event("input"))); return; }
      const shown = items.filter(it => !sel.includes(it.name));
      results.innerHTML = shown.length ? shown.map(it => `<button type="button" class="tech-ms-opt" data-add="${esc(it.name)}"><span class="tech-ms-nm">${esc(it.name)}</span>${it.category ? `<span class="tech-ms-cat">${esc(it.category)}</span>` : ""}</button>`).join("") : `<div class="tech-ms-empty">No match in the dictionary.</div>`;
      results.querySelectorAll('[data-add]').forEach(b => b.onclick = () => add(b.dataset.add));
    }, 160);
  };
  paintChips();
}
let edTechSel = []; // selected technologies for the tracker editor (read on save)
let edMatchFilter = null;          // the creator's optional advanced matching-rule tree (search.matchFilter)

// Segmented button group (.hc-mode) as a value picker. Reads/writes the pressed button via data-v,
// returns a getter/setter. Used for keyword scope (Anywhere / Title only / Description only).
function segControl(id, onChange) {
  const el = $(id); if (!el) return { get: () => "anywhere", set: () => {} };
  const btns = [...el.querySelectorAll("button")];
  const paint = (v) => btns.forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  btns.forEach((b) => b.onclick = () => { paint(b.dataset.v); onChange?.(b.dataset.v); });
  return {
    get: () => (btns.find((b) => b.classList.contains("active"))?.dataset.v) || (btns[0]?.dataset.v) || "anywhere",
    set: (v, fire) => { paint(v || (btns[0]?.dataset.v)); if (fire) onChange?.(v); },
  };
}
// One instance per scope control id; created lazily so the DOM exists first.
const _scopeCtls = new Map();
const scopeCtl = (id) => { let c = _scopeCtls.get(id); if (!c) { c = segControl(id); _scopeCtls.set(id, c); } return c; };
// Wire every scope segmented control up-front. segControl attaches its click handlers on construction,
// so a control read only at submit time (Account Check) would otherwise ignore clicks made before then.
// The monitor editor also inits via fillForm; this makes every path safe.
["fKwScope", "fExcludeScope", "acKwScope"].forEach((id) => scopeCtl(id));

// The unified creator's cadence toggle (Keep watching / Check once). "Once" hides the schedule +
// webhook (irrelevant to a one-off snapshot) and relabels Save; "Watch" restores them. The chosen
// value is read at save time to route to the right backend (a saved monitor vs a one-off check).
function applyCadence(mode) {
  const once = mode === "once";
  const sched = $("fScheduleField"), wh = $("fWebhookField");
  if (sched) sched.style.display = once ? "none" : "";
  if (wh) wh.style.display = once ? "none" : "";
  const save = $("saveBtn"); if (save && !editingName) save.textContent = once ? "Run check" : "Save";
}
const cadenceCtl = segControl("fCadence", applyCadence);

function fillForm(c) {
  const s = c.search || {};
  $("fName").value = c.name || "";
  cadenceCtl.set("watch", true); // saved trackers are always continuous; a one-off check is never edited
  $("fActive").checked = c.active !== false;
  $("fKeywords").value = (s.keywords || []).join("\n");
  scopeCtl("fKwScope").set(s.keywordScope || "anywhere");
  $("fExactMatch").checked = !!s.exactMatch;
  $("fExclude").value = (s.exclude || []).join("\n");
  scopeCtl("fExcludeScope").set(s.excludeKeywordScope || "anywhere");
  $("fExcludeCompanies").value = (s.excludeCompanies || []).join("\n");
  edTechSel = (s.technologies || []).slice(); buildTechPicker("fTechPicker", edTechSel);
  edMatchFilter = s.matchFilter || null; renderMatchFilterBtn();
  $("fOrgDomains").value = (s.orgDomains || []).join("\n");
  $("fUseAts").checked = s.useAts !== false;   // absent means ON — ingest gates on `useAts !== false`
  $("fSearchDepth").value = s.searchDepth || "deep";
  renderScheduleBuilder("fSchedule", c.schedule || cronToSchedule(c.refreshCron));
  $("fIncludeOrg").checked = !!s.includeOrgJobs;
  const boards = s.extraBoards || [];
  $("fBoardRemoteok").checked = boards.includes("remoteok");
  $("fBoardWwr").checked = boards.includes("wwr");
  $("fWebhook").value = c.delivery?.webhook_url || "";
  renderSignalPicker("fSignals", c.signals || []);
  renderSigRoutes("fSigRoutes", c.signal_webhooks);
  fillHcFilters("f", s);
}

function collectForm() {
  const kws = lines("fKeywords"), domains = lines("fOrgDomains");
  // Target is implicit: domains-only (no keywords) is an Account Monitoring watchlist; anything with
  // keywords is a keyword search (which may ALSO scan named domains). This is what lets one creator
  // produce every tracker type without a separate "type" control.
  const kind = (domains.length && !kws.length) ? "watchlist" : "search";
  return {
    name: $("fName").value.trim(), active: $("fActive").checked, kind,
    search: {
      keywords: lines("fKeywords"), exclude: lines("fExclude"),
      keywordScope: scopeCtl("fKwScope").get(),
      excludeKeywordScope: scopeCtl("fExcludeScope").get(),
      exactMatch: $("fExactMatch").checked,
      excludeCompanies: lines("fExcludeCompanies"),
      technologies: edTechSel.slice(),
      matchFilter: edMatchFilter || undefined,
      orgDomains: lines("fOrgDomains"),
      useAts: $("fUseAts").checked,
      includeOrgJobs: $("fIncludeOrg").checked,
      extraBoards: [...($("fBoardRemoteok").checked ? ["remoteok"] : []), ...($("fBoardWwr").checked ? ["wwr"] : [])],
      searchDepth: $("fSearchDepth").value || "deep",
      ...collectHcFilters("f"),
    },
    schedule: readScheduleBuilder("fSchedule"),
    signals: selectedSignals("fSignals"),
    delivery: { webhook_url: $("fWebhook").value.trim(), mode: "realtime" },
    signal_webhooks: collectSigWebhooks("fSigRoutes"),
  };
}

// ── Full-control fetch schedule builder ─────────────────────────────────────────────────────────────
// Three modes the user asked for: any interval (every N min/hr/day), recurring times-on-days, and a
// one-off exact date-time. Renders into a host div; readScheduleBuilder() returns the FetchSchedule the
// backend (src/scheduler.ts) compiles into timers. cronToSchedule() maps a legacy refreshCron for display.
const SCHED_DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function cronToSchedule(cronStr) {
  const c = (cronStr || "0 * * * *").trim().split(/\s+/);
  if (c.length === 5) {
    const [mi, hr, dom, , dow] = c; let m;
    if (dom === "*" && dow === "*") {
      if (hr === "*" && mi === "0") return { mode: "interval", every: 1, unit: "hour" };
      if ((m = /^\*\/(\d+)$/.exec(hr)) && mi === "0") return { mode: "interval", every: +m[1], unit: "hour" };
      if ((m = /^\*\/(\d+)$/.exec(mi)) && hr === "*") return { mode: "interval", every: +m[1], unit: "minute" };
      if (/^\d+$/.test(hr) && /^\d+$/.test(mi)) return { mode: "recurring", times: [`${hr.padStart(2, "0")}:${mi.padStart(2, "0")}`], days: "everyday" };
    }
  }
  return { mode: "interval", every: 6, unit: "hour" };
}
function scheduleNextRun(s) {
  const now = new Date();
  if (!s) return null;
  if (s.mode === "interval") { const u = s.unit === "minute" ? 60000 : s.unit === "hour" ? 3600000 : 86400000; return new Date(now.getTime() + Math.max(60000, s.every * u)); }
  if (s.mode === "once") { const d = new Date(s.at); return isNaN(d) ? null : d; }
  if (s.mode === "recurring") {
    const times = (s.times || []).map((t) => t.split(":").map(Number)).filter((a) => a.length === 2 && a[0] < 24 && a[1] < 60).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!times.length) return null;
    const dayOk = (d) => { const dw = d.getDay(), dm = d.getDate();
      if (s.daysOfWeek?.length) return s.daysOfWeek.includes(dw);
      if (s.daysOfMonth?.length) return s.daysOfMonth.includes(dm);
      if (s.days === "weekdays") return dw >= 1 && dw <= 5;
      if (s.days === "weekends") return dw === 0 || dw === 6;
      return true; };
    for (let i = 0; i < 400; i++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      if (!dayOk(day)) continue;
      for (const [h, m] of times) { const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); if (cand > now) return cand; }
    }
  }
  return null;
}
function fmtNextRun(s) {
  if (s?.mode === "once") { const d = new Date(s.at); if (!s.at || isNaN(d)) return "Pick a date and time."; if (d <= new Date()) return "⚠ That time has already passed — it won't run."; }
  const d = scheduleNextRun(s);
  if (!d) return "—";
  const diff = d - new Date(), mins = Math.round(diff / 60000);
  const rel = mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.round(mins / 60)} h` : `in ${Math.round(mins / 1440)} d`;
  const abs = d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `Next run: ${abs} · ${rel}`;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function localDatetimeValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function renderScheduleBuilder(hostId, sched) {
  const host = $(hostId);
  const s = sched && sched.mode ? sched : cronToSchedule(sched);
  const mode = ["interval", "recurring", "once"].includes(s.mode) ? s.mode : "interval";
  host.innerHTML = `
    <div class="sched-modes">
      <button type="button" data-m="interval">Every…</button>
      <button type="button" data-m="recurring">At set times</button>
      <button type="button" data-m="once">Once</button>
    </div>
    <div class="sched-panel" data-panel="interval">
      <span class="sched-lab">Run every</span>
      <input type="number" class="sched-num" min="1" max="999" value="${mode === "interval" ? s.every : 6}">
      <select class="sched-unit"><option value="minute">minute(s)</option><option value="hour">hour(s)</option><option value="day">day(s)</option></select>
    </div>
    <div class="sched-panel" data-panel="recurring">
      <div class="sched-times"></div>
      <a class="sched-add">+ add a time</a>
      <div class="sched-dayrow"><span class="sched-lab">on</span>
        <select class="sched-daymode">
          <option value="everyday">every day</option><option value="weekdays">weekdays (Mon–Fri)</option>
          <option value="weekends">weekends</option><option value="dow">specific weekdays…</option>
          <option value="dom">specific days of month…</option>
        </select></div>
      <div class="sched-dow"></div>
      <input class="sched-dom" placeholder="days of month, e.g. 1, 15, 28">
    </div>
    <div class="sched-panel" data-panel="once">
      <span class="sched-lab">Run once at</span>
      <input type="datetime-local" class="sched-at">
    </div>
    <div class="sched-next"></div>`;

  const q = (sel) => host.querySelector(sel);
  const setMode = (m) => {
    host.querySelectorAll(".sched-modes button").forEach((b) => b.classList.toggle("active", b.dataset.m === m));
    host.querySelectorAll(".sched-panel").forEach((p) => p.classList.toggle("show", p.dataset.panel === m));
    preview();
  };
  const preview = () => { q(".sched-next").textContent = fmtNextRun(readScheduleBuilder(hostId)); };

  // interval
  q(".sched-unit").value = mode === "interval" ? s.unit : "hour";
  q(".sched-num").addEventListener("input", preview);
  q(".sched-unit").addEventListener("change", preview);

  // recurring — times
  const addTime = (val) => {
    const row = document.createElement("div"); row.className = "sched-timerow";
    row.innerHTML = `<input type="time" class="sched-time" value="${val || "09:00"}"><button type="button" class="sched-x" data-tip="Remove" aria-label="Remove time">${icon("x") || "✕"}</button>`;
    row.querySelector(".sched-time").addEventListener("input", preview);
    row.querySelector(".sched-x").addEventListener("click", () => { if (host.querySelectorAll(".sched-time").length > 1) { row.remove(); preview(); } });
    q(".sched-times").appendChild(row);
  };
  (mode === "recurring" && s.times?.length ? s.times : ["09:00"]).forEach(addTime);
  q(".sched-add").addEventListener("click", () => { addTime("12:00"); preview(); });

  // recurring — day mode + weekday chips + day-of-month
  const dowWrap = q(".sched-dow");
  SCHED_DOW.forEach((lbl, i) => { const b = document.createElement("button"); b.type = "button"; b.className = "sched-chip"; b.dataset.d = i; b.textContent = lbl;
    b.addEventListener("click", () => { b.classList.toggle("on"); preview(); }); dowWrap.appendChild(b); });
  const daymode = q(".sched-daymode");
  const syncDayMode = () => { dowWrap.classList.toggle("show", daymode.value === "dow"); q(".sched-dom").classList.toggle("show", daymode.value === "dom"); preview(); };
  daymode.addEventListener("change", syncDayMode);
  q(".sched-dom").addEventListener("input", preview);
  if (mode === "recurring") {
    if (s.daysOfWeek?.length) { daymode.value = "dow"; s.daysOfWeek.forEach((d) => dowWrap.querySelector(`[data-d="${d}"]`)?.classList.add("on")); }
    else if (s.daysOfMonth?.length) { daymode.value = "dom"; q(".sched-dom").value = s.daysOfMonth.join(", "); }
    else daymode.value = s.days || "everyday";
  }

  // once
  q(".sched-at").value = mode === "once" && s.at ? s.at.slice(0, 16) : localDatetimeValue(new Date(Date.now() + 3600000));
  q(".sched-at").addEventListener("input", preview);

  host.querySelectorAll(".sched-modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m)));
  syncDayMode();
  setMode(mode);
}
function readScheduleBuilder(hostId) {
  const host = $(hostId); if (!host) return { mode: "interval", every: 6, unit: "hour" };
  const mode = host.querySelector(".sched-modes button.active")?.dataset.m || "interval";
  if (mode === "interval") return { mode: "interval", every: Math.max(1, Math.min(999, +host.querySelector(".sched-num").value || 1)), unit: host.querySelector(".sched-unit").value };
  if (mode === "once") { const at = host.querySelector(".sched-at").value; return at ? { mode: "once", at } : { mode: "interval", every: 6, unit: "hour" }; }
  const times = [...host.querySelectorAll(".sched-time")].map((i) => i.value).filter(Boolean);
  const out = { mode: "recurring", times: times.length ? times : ["09:00"] };
  const dm = host.querySelector(".sched-daymode").value;
  if (dm === "dow") { const days = [...host.querySelectorAll(".sched-chip.on")].map((c) => +c.dataset.d); if (days.length) out.daysOfWeek = days; else out.days = "everyday"; }
  else if (dm === "dom") { const days = (host.querySelector(".sched-dom").value.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= 31); if (days.length) out.daysOfMonth = days; else out.days = "everyday"; }
  else out.days = dm;
  return out;
}

// The creator's "Advanced matching rules" affordance: opens the same Clay filter builder, but its
// Apply captures the tree onto edMatchFilter instead of filtering a view. countConds is hoisted.
function renderMatchFilterBtn() {
  const n = edMatchFilter ? countConds(edMatchFilter) : 0;
  const b = $("fMatchFilterBtn"), c = $("fMatchFilterClear");
  if (b) b.textContent = n ? `Edit matching rules · ${n}` : "+ Add matching rules";
  if (c) c.style.display = n ? "" : "none";
}
$("fMatchFilterBtn").onclick = () => openBuilder("trackerRule", {
  title: "Matching rules — this tracker",
  initialTree: edMatchFilter,
  onApply: (tree) => { edMatchFilter = tree; renderMatchFilterBtn(); },
});
$("fMatchFilterClear").onclick = () => { edMatchFilter = null; renderMatchFilterBtn(); };

async function openEditor(name, opts = {}) {
  editingName = name; editingConfig = null;
  $("drawerTitle").textContent = name ? "Edit tracker · " + name : "New tracker";
  $("deleteBtn").style.display = name ? "inline-flex" : "none";
  // Tell the user when this fails. With no error branch, a failed request produced no drawer, no
  // toast and no feedback at all — Edit simply looked dead, so it got clicked again and again, each
  // click firing another request at the server that was already struggling. admOpenEdit next door
  // already guards this with the comment "don't open a blank/stale drawer".
  let cfg;
  try { cfg = name ? await (await fetch("/api/clients/" + encodeURIComponent(name))).json() : structuredClone(NEW_DEFAULT); }
  catch { toast("Couldn't load that search — the engine may be restarting.", true); return; }
  editingConfig = cfg; fillForm(cfg); showMsg("", false);
  // Presets for a NEW tracker opened from a specific entry point (e.g. "One-off check" → once cadence,
  // "Watch a domain list" → focus domains). fillForm has already reset cadence to watch.
  if (!name) {
    if (opts.cadence) cadenceCtl.set(opts.cadence, true);
    if (opts.presetDomains) $("fOrgDomains").value = opts.presetDomains;
  }
  openDrawer("drawerBg", "drawer", closeEditor);
  if (!name && opts.focus === "domains") setTimeout(() => $("fOrgDomains")?.focus(), 60);
}
const closeEditor = () => { closeDrawer("drawerBg", "drawer"); };

async function saveClient() {
  let cfg; try { cfg = collectForm(); } catch (e) { return showMsg(e.message, true); }
  if (!cfg.name) return showMsg("Name is required", true);

  // "Check once" cadence: don't save a monitor — run a one-off account check on the named domains and
  // jump to its live results. (Only reachable for a NEW tracker; editing an existing one is always
  // continuous, so fillForm forces cadence back to watch.)
  if (cadenceCtl.get() === "once") {
    const domains = cfg.search.orgDomains || [];
    if (!domains.length) return showMsg("Check once needs at least one company domain below.", true);
    setBtnLoading("saveBtn", true, "Starting…"); showMsg("Starting…", false);
    try {
      const id = await startAccountCheck(cfg.name, domains, cfg.search);
      if (id) closeEditor();
    } catch (e) { showMsg(e.message || "Couldn't start the check", true); }
    finally { setBtnLoading("saveBtn", false); }
    return;
  }

  const editing = !!editingName;
  setBtnLoading("saveBtn", true, "Saving…");
  showMsg("Saving…", false);
  try {
    const res = await fetch(editing ? "/api/clients/" + encodeURIComponent(editingName) : "/api/clients", {
      method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg)
    });
    const data = await res.json();
    if (!res.ok) { showMsg(data.error || "Save failed", true); return; }
    showMsg("Saved ✓", false);
    await loadConfig();
    if (!editing) selectClient(cfg.name); else { loadStats(); loadMatches(); }
    // "matching jobs…" was true only in the narrow sense that it re-matches jobs ALREADY stored.
    // Creating a monitor triggers no source fetch at all, so on a fresh install the user watched a
    // reassuring toast, got an empty table blaming filters, and had no idea Fetch was still needed.
    toast(editing ? `Updated "${cfg.name}"` : `Created "${cfg.name}" — press Fetch to pull postings`);
    setTimeout(closeEditor, 400);
  } catch (e) { showMsg("Save failed: " + e.message, true); }
  finally { setBtnLoading("saveBtn", false); }
}

async function deleteClient() {
  if (!editingName) return;
  if (!await uiConfirm(`Delete client "${editingName}"? This removes its matches.`, { title: "Delete search", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/clients/" + encodeURIComponent(editingName), { method: "DELETE" }, "Could not delete that watchlist")) return;
  if (state.client === editingName) { state.client = ""; localStorage.setItem("se_client", ""); }
  closeEditor(); await loadConfig();
  $("tablePanel").classList.toggle("hide-client", state.client !== "");
  loadStats(); loadMatches({ background: true });
}

async function testWebhook() {
  const url = $("fWebhook").value.trim();
  if (!url) return showMsg("Enter a webhook URL first", true);
  showMsg("Sending test…", false);
  try {
    const res = await fetch("/api/test-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, client: $("fName").value || "test" }) });
    const data = await res.json();
    if (res.ok && data.ok) showMsg(`Test delivered (HTTP ${data.status})`, false);
    else showMsg("Test failed: " + (data.error || ("HTTP " + data.status)), true);
  } catch (e) { showMsg("Test failed: " + e.message, true); }
}

$("newBtn").onclick = () => openEditor(null); // one unified creator for every tracker type
// Create AND edit both go through the one unified drawer for every tracker kind. The unified drawer
// now carries the full field set — keyword scope, exact-match, advanced matching rules, the signal
// producers and per-signal routes — so a watchlist opened here keeps every setting instead of the
// old split where a search-vs-watchlist editor each had fields the other lacked.
$("editBtn").onclick = () => {
  if (!state.client) return;
  openEditor(state.client);
};
$("drawerClose").onclick = closeEditor; $("cancelBtn").onclick = closeEditor; $("drawerBg").onclick = closeEditor;
$("saveBtn").onclick = saveClient; $("deleteBtn").onclick = deleteClient; $("testWebhook").onclick = testWebhook;

// ---- Account Monitoring: watchlist editor (domains + role filter + cadence + webhook) ----
// Mirror of src/normalize.ts normalizeOrgDomain — reduce any URL/host to its bare registrable domain
// (strip scheme/path/port + common job/careers subdomains), never below 2 labels (ccTLD-safe).
const DOMAIN_STRIP = new Set(["www","jobs","job","careers","career","apply","applications","work","working","join","boards","board","go","get","hire","hiring","talent","recruiting","recruit","people","app"]);
function normDomain(input) {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^\/+/, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "").trim();
  const parts = s.split(".").filter(Boolean);
  while (parts.length > 2 && DOMAIN_STRIP.has(parts[0])) parts.shift();
  return parts.join(".");
}
const wlSplitDomains = (text) => [...new Set((text || "").split(/[\s,;]+/).map(normDomain).filter(Boolean))];
// Signal-producer catalog (for the tracker editor's checkboxes + the Signals view) — cached.
let SIG_PRODUCERS = null;
// Returns NULL when the catalogue could not be fetched — never [].
//
// [] means "the engine has no signal types", and every caller rendered exactly that: the watchlist
// editor printed "No signal types available." over a drawer where all 13 belong, and the bulk check
// refused to run with the same sentence. The engine has never had zero signal types; the request had
// failed. Reported as a fact about the product, it reads as a broken feature, and it is intermittent
// — which is the tell nobody gets to see, because the sentence is so definite.
//
// The failure is deliberately not cached (SIG_PRODUCERS stays null), so the next call retries.
async function sigProducers() {
  if (!SIG_PRODUCERS) {
    try { SIG_PRODUCERS = (await fjson("/api/signals/producers")).items || []; } catch { return null; }
  }
  return SIG_PRODUCERS;
}
// Meta Ad Library regions — fetched once from the server so Settings and the check screen share ONE
// list (the codes live in src/signals/adActivity.ts). `default` is the saved Settings value.
let AD_REGIONS = null;
// The fallback is a real value, not a cached one: a failed fetch must not be remembered (the next
// call should retry), but it must still be USABLE. Both consumers below used to read the AD_REGIONS
// cache directly and ignore this return value, so on a timeout they saw null → zero options → a
// blank, unusable "Look for ads in" dropdown, because enhanceSelect's syncLabel reads options[-1].
const AD_REGIONS_FALLBACK = { items: [{ code: "ALL", label: "Worldwide (recommended)" }], default: "ALL" };
async function adRegions() {
  if (!AD_REGIONS) {
    try { AD_REGIONS = await fjson("/api/signals/ad-regions"); }
    catch { return AD_REGIONS_FALLBACK; }
  }
  return AD_REGIONS;
}
const adRegionItems = () => (AD_REGIONS?.items?.length ? AD_REGIONS.items : AD_REGIONS_FALLBACK.items);
const adRegionOptions = (sel) => adRegionItems()
  .map((r) => `<option value="${esc(r.code)}"${r.code === sel ? " selected" : ""}>${esc(r.label)}</option>`).join("");
/** Human label for a stored region code ("DE" → "Germany only"). */
const adRegionLabel = (code) => adRegionItems().find((r) => r.code === code)?.label || code;

async function renderSignalPicker(boxId, selected) {
  const box = $(boxId); if (!box) return;
  const items = await sigProducers();
  // Three outcomes, not two. null = we could not ask; [] = the engine genuinely offers none.
  if (!items) {
    box.innerHTML = '<span class="hint">Couldn\u2019t load the signal types — the engine may be busy. <button type="button" class="lnk" data-sig-retry>Try again</button></span>';
    const b = box.querySelector("[data-sig-retry]");
    if (b) b.onclick = () => renderSignalPicker(boxId, selected);
    return;
  }
  box.innerHTML = items.length
    ? items.map((p) => `<label data-tip="${esc(p.description)}"><input type="checkbox" data-sig="${esc(p.key)}" ${selected.includes(p.key) ? "checked" : ""}/> ${esc(p.label)}</label>`).join("")
    : '<span class="hint">No signal types available.</span>';
}
const selectedSignals = (boxId) => [...document.querySelectorAll('#' + boxId + ' input[data-sig]:checked')].map((i) => i.dataset.sig);

// Per-signal-type webhook routing (watchlist): a URL per signal family; non-empty ones override the
// default webhook for that family. Keys are signal FAMILIES (first segment of the type).
const SIGNAL_ROUTE_FAMILIES = [
  ["funding", "Funding (SEC)"], ["warn", "Layoffs (WARN)"], ["ads", "Meta ads"], ["velocity", "Hiring velocity"],
  ["news", "News"], ["ph", "Product Hunt"], ["ats", "ATS change"], ["tech", "Tech change"],
];
function renderSigRoutes(boxId, map) {
  const box = $(boxId); if (!box) return; map = map || {};
  box.innerHTML = SIGNAL_ROUTE_FAMILIES.map(([fam, label]) =>
    `<div class="wl-route"><span class="wl-route-lbl">${esc(label)}</span>
      <input type="url" data-sigwh="${fam}" value="${esc(map[fam] || "")}" placeholder="default webhook" /></div>`).join("");
}
function collectSigWebhooks(boxId) {
  const out = {};
  document.querySelectorAll('#' + boxId + ' input[data-sigwh]').forEach((i) => { const v = i.value.trim(); if (v) out[i.dataset.sigwh] = v; });
  return out;
}
// ---- Help banner (first-run guide; dismissible + reopenable) ----
const HELP_KEY = "se_help_dismissed";
// The guide is opt-in — summonable any time from the sidebar "How it works" button — so it never eats
// space on a returning user's screen. (Was auto-shown until dismissed.)
$("helpClose").onclick = () => { $("helpBanner").classList.add("hidden"); localStorage.setItem(HELP_KEY, "1"); };
$("helpBtn").onclick = () => $("helpBanner").classList.toggle("hidden");

// ---- Settings drawer (job retention + webhook batching) ----
const RET_GUIDE = {
  off: "<b>Keep all</b> — every job stays and shows on the dashboard, no matter how old.",
  hide: "<b>Hide it</b> — old jobs drop off the dashboard but stay in the database, so webhooks and history are untouched. Fully reversible.",
  delete: "<b>Delete it</b> — old jobs are permanently removed (a cleanup runs daily at 3am, plus the button below). Frees space; can't be undone.",
};
let setRetModeVal = "off";
function paintRetMode(v) {
  setRetModeVal = v;
  $("setRetMode").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.v === v));
  $("retGuide").innerHTML = RET_GUIDE[v] || "";
  refreshOldCount();
}
$("setRetMode").querySelectorAll("button").forEach(b => b.onclick = () => paintRetMode(b.dataset.v));

// Fetch speed dial
const SPEED_GUIDE = {
  gentle: "<b>Gentle</b> — fewest requests at once. Slowest, but the lightest touch on the source. Best if you ever see blocks.",
  normal: "<b>Normal</b> — balanced. Fetches several pages at a time and adapts up or down automatically. The right default.",
  aggressive: "<b>Aggressive</b> — highest parallelism for the fastest fetches. Still backs off automatically on any push-back — it just aims higher first.",
};
let setSpeedVal = "normal";
function paintSpeed(v) {
  setSpeedVal = ["gentle", "normal", "aggressive"].includes(v) ? v : "normal";
  $("setSpeed").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.v === setSpeedVal));
  $("speedGuide").innerHTML = SPEED_GUIDE[setSpeedVal] || "";
}
$("setSpeed").querySelectorAll("button").forEach(b => b.onclick = () => paintSpeed(b.dataset.v));

// Desktop notifications (free, browser-native) when a background fetch lands new matches.
const NOTIFY_KEY = "se_notify";
function paintNotifyGuide() {
  const on = localStorage.getItem(NOTIFY_KEY) === "1";
  const perm = ("Notification" in window) ? Notification.permission : "unsupported";
  $("notifyGuide").innerHTML = perm === "unsupported" ? "Your browser doesn't support desktop notifications."
    : perm === "denied" ? "Notifications are blocked in your browser settings — enable them there first."
    : on ? "On. You'll get a popup when a fetch finds new matches while this tab is in the background." : "Off.";
}
$("setNotify").onchange = async () => {
  if ($("setNotify").checked) {
    if (!("Notification" in window)) { $("setNotify").checked = false; return paintNotifyGuide(); }
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") { $("setNotify").checked = false; localStorage.setItem(NOTIFY_KEY, "0"); return paintNotifyGuide(); }
    localStorage.setItem(NOTIFY_KEY, "1");
  } else localStorage.setItem(NOTIFY_KEY, "0");
  paintNotifyGuide();
};
function maybeNotify(a) {
  if (localStorage.getItem(NOTIFY_KEY) !== "1" || !("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden) return; // don't interrupt while you're looking at the app
  const n = Number(a.matched || a.fresh || 0); if (!n) return;
  try {
    const note = new Notification("HyperSignal — new matches", { body: `"${a.client}": ${n} new match${n === 1 ? "" : "es"} found`, tag: a.key });
    note.onclick = () => { window.focus(); try { jumpToFetch(a); } catch {} note.close(); };
  } catch { /* notification failed — ignore */ }
}

async function refreshOldCount() {
  const days = Math.max(1, Number($("setRetDays").value) || 30);
  try {
    const r = await (await fetch("/api/jobs/old-count?days=" + days)).json();
    const one = r.count === 1;
    const verb = setRetModeVal === "delete" ? "would be deleted" : setRetModeVal === "hide" ? "would be hidden now" : (one ? "is older than this" : "are older than this");
    $("oldCountGuide").innerHTML = `<b>${r.count.toLocaleString()}</b> job${one ? "" : "s"} ${verb} (older than ${days} days).`;
  } catch {}
}
let ocTimer;
$("setRetDays").oninput = () => { clearTimeout(ocTimer); ocTimer = setTimeout(refreshOldCount, 250); };

async function openSettings() {
  let s;
  try { s = await (await fetch("/api/settings")).json(); }
  catch { toast("Couldn't load settings — the engine may be restarting.", true); return; }
  $("setRetDays").value = s.retentionDays;
  $("setBatch").value = s.webhookBatchSize;
  paintRetMode(s.retentionMode);
  paintSpeed(s.fetchSpeed);
  $("setNotify").checked = localStorage.getItem(NOTIFY_KEY) === "1"; paintNotifyGuide();
  $("setAutoQuit").checked = !!s.autoShutdown; paintAutoQuitGuide();
  // The server no longer sends the key back, only whether one is stored. The field therefore starts
  // empty and means "replace it with what I type"; leaving it blank keeps whatever is saved.
  $("setChKey").value = "";
  $("setChKey").placeholder = s.companiesHouseKeySet ? "key saved — type a new one to replace it" : "empty = UK filings signal off";
  $("setChKeyClear").hidden = !s.companiesHouseKeySet;
  $("setAutoResolve").checked = s.autoResolveDomains !== false;
  await adRegions();
  $("setAdCountry").innerHTML = adRegionOptions(s.adCountry || "ALL");
  $("setAdCountry").value = s.adCountry || "ALL";
  $("settingsMsg").textContent = "";
  refreshTechCount();
  openDrawer("settingsBg", "settingsDrawer", closeSettings);
}
async function refreshTechCount() {
  try { const r = await (await fetch("/api/technologies")).json(); $("techCount").innerHTML = `<b>${fmtNum(r.count)}</b> technologies in the detection dictionary.`; }
  catch { $("techCount").textContent = "—"; }
}
$("techImportBtn").onclick = async () => {
  const text = $("techImport").value.trim();
  const msg = $("techMsg");
  if (!text) { msg.textContent = "Paste a list first."; msg.className = "msg err"; return; }
  const mode = document.querySelector('input[name="techMode"]:checked')?.value || "merge";
  if (mode === "replace" && !await uiConfirm("Replace the ENTIRE technology dictionary with this list? Every job is then re-scanned against the new list. This can't be undone.", { title: "Replace dictionary", confirmLabel: "Replace" })) return;
  msg.textContent = "Importing + re-scanning jobs…"; msg.className = "msg";
  $("techImportBtn").disabled = true;
  try {
    const res = await fetch("/api/technologies/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, mode }) });
    const d = await res.json();
    if (!res.ok) { msg.textContent = d.error || "Import failed."; msg.className = "msg err"; return; }
    msg.textContent = `Imported ${fmtNum(d.imported)} · ${fmtNum(d.total)} total · re-tagged ${fmtNum(d.retagged)} jobs.`; msg.className = "msg ok";
    $("techImport").value = ""; refreshTechCount();
  } catch { msg.textContent = "Import failed."; msg.className = "msg err"; }
  finally { $("techImportBtn").disabled = false; }
};
const closeSettings = () => { closeDrawer("settingsBg", "settingsDrawer"); };
const setMsg = (t, err) => { const m = $("settingsMsg"); m.textContent = t; m.className = "msg " + (err ? "err" : "ok"); };

$("settingsBtn").onclick = openSettings;
$("settingsCloseX").onclick = closeSettings; $("settingsCancel").onclick = closeSettings; $("settingsBg").onclick = closeSettings;
$("settingsSave").onclick = async () => {
  setMsg("Saving…", false);
  const body = { retentionMode: setRetModeVal, retentionDays: Math.max(1, Number($("setRetDays").value) || 30), webhookBatchSize: Math.max(0, Number($("setBatch").value) || 0), fetchSpeed: setSpeedVal, autoResolveDomains: $("setAutoResolve").checked, adCountry: $("setAdCountry").value };
  // Only send the key when the user actually typed one — the server keeps the stored value for an
  // omitted field, so a blank box must not be read as "clear it" (that's what Remove key is for).
  const chTyped = $("setChKey").value.trim();
  if (chTyped) body.companiesHouseKey = chTyped;
  // Same as the admin save: unguarded, so a failed request left the footer on "Saving…".
  let res, data;
  try { res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); data = await res.json(); }
  catch (e) { return setMsg("Couldn't reach the server — " + (e?.message || "try again"), true); }
  if (!res.ok) { // e.g. a rejected API key — show the reason on the field too, not just the footer
    if (data.error && /api key|email address|too short|spaces/i.test(data.error)) $("chKeyGuide").innerHTML = `<span style="color:var(--danger)">${esc(data.error)}</span>`;
    return setMsg(data.error || "Save failed", true);
  }
  setMsg("Saved ✓", false);
  loadStats(); loadMatches(); // hide-mode toggles affect the table immediately
  setTimeout(closeSettings, 500);
};
// "Quit when I close the window" — instant-apply (independent of the Save button below).
function paintAutoQuitGuide() {
  const on = $("setAutoQuit").checked;
  $("autoQuitGuide").innerHTML = on
    ? "Closing the last window quits the app a few seconds later. A reload or a second open tab won't quit it."
    : "The app keeps running in the background (still collecting signals) after you close the window. Use <b>Stop Signal Engine</b> to quit it.";
}
// "Test key" — if you typed one, it is saved first so you test what's in the box; if the box is
// blank it tests the already-saved key. Sending an empty string would CLEAR the saved key, and the
// box is now always blank on open, so an untyped test must omit the field entirely.
$("setChKeyTest").onclick = async () => {
  const btn = $("setChKeyTest"), g = $("chKeyGuide");
  btn.disabled = true; btn.textContent = "Testing…";
  try {
    const typed = $("setChKey").value.trim();
    const res = await fetch("/api/companies-house/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(typed ? { key: typed } : {}) });
    const d = await res.json();
    g.innerHTML = d.ok ? `<span style="color:var(--good)">✓ ${esc(d.message)}</span>` : `<span style="color:var(--danger)">${esc(d.message)}</span>`;
    toast(d.ok ? "Companies House key works" : "Key test failed — see the note under the field", !d.ok);
    if (d.ok && typed) { $("setChKey").value = ""; $("setChKey").placeholder = "key saved — type a new one to replace it"; $("setChKeyClear").hidden = false; }
  } catch { toast("Couldn't run the test", true); }
  finally { btn.disabled = false; btn.textContent = "Test key"; }
};
// The only way to clear a saved key, now that a blank box means "keep it".
$("setChKeyClear").onclick = async () => {
  if (!await uiConfirm("Remove the Companies House key? The UK share-allotment signal will stop running.", { title: "Remove key", confirmLabel: "Remove", danger: true })) return;
  try {
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companiesHouseKey: "" }) });
    if (!res.ok) throw new Error();
    $("setChKey").value = ""; $("setChKey").placeholder = "empty = UK filings signal off";
    $("setChKeyClear").hidden = true;
    $("chKeyGuide").textContent = "Key removed. The UK share-allotment signal is off until you add one.";
    toast("Companies House key removed");
  } catch { toast("Couldn't remove the key", true); }
};
$("setAutoQuit").onchange = async () => {
  paintAutoQuitGuide();
  try {
    const res = await fetch("/api/app/auto-quit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: $("setAutoQuit").checked }) });
    if (!res.ok) throw new Error();
    toast($("setAutoQuit").checked ? "Will quit when you close the window" : "Will keep running in the background");
  } catch { toast("Couldn't save that setting", true); }
};

// ---- Tab session heartbeat: lets the server know when the last dashboard window closes ----
// One id per browser tab (survives reloads via sessionStorage). We ping on load and whenever the tab
// returns to the foreground, and fire a "bye" beacon on close. The server only acts on this when the
// "Quit when I close the window" setting is on; a reload re-pings within the grace window and cancels.
const SE_TAB_ID = (() => {
  let id = sessionStorage.getItem("se_tab_id");
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); sessionStorage.setItem("se_tab_id", id); }
  return id;
})();
const seSessionPing = () => { try { fetch("/api/session/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: SE_TAB_ID }), keepalive: true }); } catch {} };
seSessionPing();
window.addEventListener("pageshow", (e) => { if (e.persisted) seSessionPing(); }); // restored from bfcache
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") seSessionPing(); });
window.addEventListener("pagehide", () => {
  try {
    const blob = new Blob([JSON.stringify({ id: SE_TAB_ID })], { type: "application/json" });
    navigator.sendBeacon("/api/session/bye", blob);
  } catch {}
});
// ---- Account Check section (saved, named, searchable, stoppable, live-building) ----
let acCompanies = [], acRows = null, acMode = "none";
let acDetail = { id: null, es: null, hits: [], status: null, counters: {} };
const acMsg = (t, err) => { const m = $("acMsg"); m.textContent = t; m.className = "msg " + (err ? "err" : "ok"); };

// RFC-4180-ish CSV parser (handles quoted fields, embedded commas/newlines).
function acParseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== "")); // drop blank rows
}
const acHeaderish = (cell) => { const c = (cell || "").trim(); return c.length > 0 && c.length <= 28 && /\b(compan(y|ies)|names?|employer|account|organi[sz]ation|org|business|vendor|supplier|domain|website|url)\b/i.test(c); };
function acDetectHeader(rows) {
  if (rows.length < 2) return false;
  const cols = Math.max(...rows.map((r) => r.length));
  return cols > 1 ? true : acHeaderish(rows[0][0]); // multi-column CSVs essentially always have a header row
}
function acColumns() {
  if (!acRows || !acRows.length) return [];
  const n = Math.max(...acRows.map((r) => r.length));
  const useHeader = $("acHeader").checked;
  return Array.from({ length: n }, (_, i) => (useHeader && acRows[0][i]?.trim()) ? acRows[0][i].trim() : `Column ${i + 1}`);
}
function acBestColumn(cols) {
  let d = cols.findIndex((c) => /^(domain|website|url|site|web)\b/i.test(c));
  if (d < 0) d = cols.findIndex((c) => /domain|website|\burl\b|site/i.test(c));
  if (d >= 0) return d;
  // fall back to a company/name-ish column — its values still get normalized to a bare domain
  let i = cols.findIndex((c) => /^compan|employer|^account|organi[sz]ation|^business/i.test(c));
  if (i < 0) i = cols.findIndex((c) => /name/i.test(c));
  return i < 0 ? 0 : i;
}
// Cell strings for the chosen column (file) or pasted lines, each normalized to its bare domain
// (Account Check is domain-only — hiring.cafe keys company pages by domain).
function acCells() {
  let raw;
  if (acMode === "paste") raw = $("acNames").value.split(/\r?\n/).map((l) => l.split(",")[0]);
  else if (!acRows) return [];
  else { const idx = Number($("acColumn").value) || 0; const data = $("acHeader").checked ? acRows.slice(1) : acRows; raw = data.map((r) => r[idx] || ""); }
  return raw.map(normDomain);
}
// Dedup case-insensitively (keep first-seen casing); report blanks + duplicates dropped.
function acDedup(cells) {
  const seen = new Set(); const values = []; let dupes = 0, blanks = 0;
  for (const raw of cells) {
    const v = (raw || "").trim();
    if (!v) { blanks++; continue; }
    const k = v.toLowerCase();
    if (seen.has(k)) dupes++; else { seen.add(k); values.push(v); }
  }
  return { values, dupes, blanks };
}
function acRenderMap(resetCol) {
  if (!acRows) { $("acMapWrap").style.display = "none"; return; }
  $("acMapWrap").style.display = "block";
  const cols = acColumns();
  const keep = resetCol ? acBestColumn(cols) : Math.min(Number($("acColumn").value) || 0, cols.length - 1);
  $("acColumn").innerHTML = cols.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join("");
  $("acColumn").value = String(keep);
  acRenderPreview();
}
function acRenderPreview() {
  const { values } = acDedup(acCells());
  const rows = values.slice(0, 10).map((v) => `<tr><td>${esc(v)}</td></tr>`).join("") || `<tr class="none"><td>(no values in this column)</td></tr>`;
  $("acPreview").innerHTML = `<table class="ac"><thead><tr><th>Preview — first ${Math.min(10, values.length)} of ${values.length}</th></tr></thead><tbody>${rows}</tbody></table>`;
  acUpdateCount();
}
function acUpdateCount() {
  const { values, dupes, blanks } = acDedup(acCells());
  acCompanies = values;
  const drops = [];
  if (dupes) drops.push(`${dupes} duplicate${dupes === 1 ? "" : "s"}`);
  if (blanks) drops.push(`${blanks} blank${blanks === 1 ? "" : "s"}`);
  const noun = `domain${values.length === 1 ? "" : "s"}`;
  $("acCount").innerHTML = `${values.length} ${noun} selected`
    + (drops.length ? ` <span style="color:var(--faint)">· ${drops.join(" & ")} skipped</span>` : "");
}
wireDrop("acDrop", "acFile");
$("acFile").onchange = async () => {
  const f = $("acFile").files[0]; if (!f) return;
  acRows = acParseCSV(await f.text()); acMode = "file";
  $("acNames").style.display = "none";
  $("acDrop").innerHTML = dropChosenHtml(f.name, `${acRows.length} row${acRows.length === 1 ? "" : "s"}`);
  $("acHeader").checked = acDetectHeader(acRows);
  acRenderMap(true);
};
$("acColumn").onchange = acRenderPreview;
$("acHeader").onchange = () => acRenderMap(false);
$("acNames").oninput = acUpdateCount;
$("acPasteToggle").onclick = () => {
  if (acMode === "paste") { // toggle back to upload
    acMode = "none"; $("acNames").style.display = "none"; $("acPasteToggle").textContent = "or paste a list instead";
    if (acRows) acRenderMap(false); else $("acCount").textContent = "No file selected";
  } else {
    acMode = "paste"; acRows = null; $("acMapWrap").style.display = "none";
    $("acNames").style.display = "block"; $("acNames").focus();
    $("acDrop").innerHTML = dropDefaultHtml('one bare domain per row — e.g. stripe.com');
    $("acPasteToggle").textContent = "use a CSV upload instead";
    acUpdateCount();
  }
};
// ---- screen switching + open/close ----
function acShow(screen) {
  $("acScreenList").style.display = screen === "list" ? "block" : "none";
  $("acScreenNew").style.display = screen === "new" ? "block" : "none";
  $("acScreenDetail").style.display = screen === "detail" ? "block" : "none";
  $("acTitle").textContent = screen === "new" ? "New one-off check" : screen === "detail" ? "One-off check" : "One-off checks";
}
function acCloseStream() { if (acDetail.es) { acDetail.es.close(); acDetail.es = null; } }
$("acNewBtn").onclick = () => {
  acShow("new"); $("acMsg").textContent = ""; fillHcFilters("ac", {});
  acMode = "none"; acRows = null; acCompanies = [];
  $("acNames").value = ""; $("acNames").style.display = "none"; $("acMapWrap").style.display = "none";
  $("acDrop").innerHTML = 'Click to upload a <b>.csv</b> of domains<span class="rnote" style="display:block">one bare domain per row — e.g. stripe.com</span>';
  $("acPasteToggle").textContent = "or paste a list instead";
  $("acName").value = ""; $("acCount").textContent = "No domains selected";
};
$("acNewBack").onclick = () => { acShow("list"); acLoadList(); };
$("acDetailBack").onclick = () => { acCloseStream(); acShow("list"); acLoadList(); };

// ---- saved-search list ----
const acStatusChip = (s) => {
  const m = { running: ["running", "#b45309", "#fff7ed", "ac-chip run"], done: ["done", "#0f9d6b", "#e7f6ef", "ac-chip"],
    stopped: ["stopped", "#6b7280", "#f3f4f6", "ac-chip"], error: ["error", "#b91c1c", "#fef2f2", "ac-chip"] };
  // The fallback arm puts the RAW status straight into the markup — every other arm is a literal
  // from the map above, but this one is whatever the server sent. esc() it.
  const [t, c, bg, cls] = m[s] || [s, "#5b616e", "#f3f4f6", "ac-chip"];
  return `<span class="${cls}" style="color:${c};background:${bg}">${esc(t)}</span>`;
};
function acAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z"); // SQLite UTC datetime
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}
function acRowHtml(r) {
  const pct = r.total ? Math.round((r.checked / r.total) * 100) : 0;
  return `<div class="ac-row" data-id="${esc(r.id)}">
    <div class="ac-row-main">
      <div class="ac-row-name">${esc(r.name)}</div>
      <div class="ac-row-sub">${acStatusChip(r.status)}
        <span>${(r.found || 0).toLocaleString()}/${(r.total || 0).toLocaleString()} hiring</span> ·
        <span>${(r.totalHits || 0).toLocaleString()} openings</span> ·
        <span class="ac-ago">${acAgo(r.createdAt)}</span></div>
      ${r.status === "running" ? `<div class="ac-mini-bar"><div style="width:${pct}%"></div></div>` : ""}
    </div>
    <button class="ac-row-del" data-del="${esc(r.id)}" data-tip="Delete" aria-label="Delete">${icon('x')}</button>
  </div>`;
}
/** True while the user is interacting with the saved-check list, so a poll can stand down.
 *  Focus inside it, a live text selection over it, or an open dropdown anywhere. */
function acListBusy() {
  const box = $("acSavedList");
  if (!box) return false;
  if (box.contains(document.activeElement) || $("acSearch") === document.activeElement) return true;
  if (document.querySelector(".ms-panel.open, .od.open")) return true;
  const sel = window.getSelection?.();
  return !!(sel && !sel.isCollapsed && sel.anchorNode && box.contains(sel.anchorNode));
}
async function acLoadList() {
  const q = $("acSearch").value.trim();
  const tok = loadToken("acList");   // the search box debounces, but two keystrokes can still race
  let d;
  try {
    const r = await fetch("/api/account/searches" + (q ? "?q=" + encodeURIComponent(q) : ""));
    if (!r.ok || !(r.headers.get("content-type") || "").includes("application/json")) throw 0;
    d = await r.json();
  } catch { $("acSavedList").innerHTML = `<div class="ac-empty">Couldn't load saved checks — restart the app to update it.</div>`; return; }
  if (loadStale("acList", tok)) return;
  const rows = d.items || [];
  $("acSavedList").innerHTML = rows.length
    ? rows.map(acRowHtml).join("")
    : `<div class="ac-empty">${q ? "No checks match that search." : 'No saved checks yet. Click "+ New check" to run one.'}</div>`;
}
let acSearchT;
$("acSearch").oninput = () => { clearTimeout(acSearchT); acSearchT = setTimeout(acLoadList, 180); };
$("acSavedList").onclick = async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); if (!await uiConfirm("Delete this saved check? Its results will be removed.", { title: "Delete saved check", confirmLabel: "Delete", danger: true })) return;
    if (await mutate("/api/account/searches/" + del.getAttribute("data-del"), { method: "DELETE" }, "Could not delete that check")) acLoadList();
    return; }
  const row = e.target.closest(".ac-row");
  if (row) acOpenDetail(row.getAttribute("data-id"));
};
// Light auto-refresh so running checks tick forward while the list is on screen.
setInterval(() => {
  if (state.view !== "checking" || $("acScreenList").style.display === "none") return;
  // Never rebuild while the user is IN the list. acLoadList replaces the container's innerHTML,
  // which drops focus, clears a text selection and closes any open dropdown — every 5 seconds,
  // mid-interaction. Skipping a tick costs nothing: the next one is 5s away.
  if (acListBusy()) return;
  acLoadList();
}, 5000);

// ---- detail view (params + live-building results) ----
function acHitRow(h) {
  // When a description was scraped, make the role expandable to read it inline.
  const role = h.description
    ? `<details class="ac-desc"><summary>${esc(h.title)}</summary><div>${esc(h.description)}</div></details>`
    : esc(h.title);
  return `<tr>
    <td>${esc(h.input_company)}</td>
    <td>${h.matched_company ? esc(h.matched_company) : "—"}</td>
    <td>${role}</td>
    <td>${esc(h.location || "—")}</td>
    <td class="reason">${matchedWhereHtml(h)}</td>
    <td>${h.status === "closed" ? '<span class="chip closed">closed</span>' : '<span class="chip open">open</span>'}</td>
    <td>${safeUrl(h.url) ? `<a href="${safeUrl(h.url)}" target="_blank" rel="noopener">view ${icon('external')}</a>` : "—"}</td></tr>`;
}
// This table was the one list in the app with no pager: it rendered EVERY matched opening into one
// DOM table, re-running the whole map on each Advanced-filter change, against a 10,000-domain cap.
// Paged at the project-standard 15 like every other table. The page is sliced from the FILTERED array
// rather than fetched, so the Advanced filter still applies to the whole result set and the CSV export
// is unaffected — moving the slice server-side would silently reduce the filter to the current page.
let acOffset = 0;
const AC_PAGE = 15;
// Its OWN container. scrollResultsTop() targets #coScroll / #tblScroll — the Companies and Jobs
// tables — so reusing it here would scroll a different screen. Instant, not smooth: the one
// smooth-scroll in the app is already flagged as ignoring prefers-reduced-motion.
const acScrollTop = () => $("acResults")?.scrollTo({ top: 0 });
// Column sort for the check-results grid. Applied to the WHOLE filtered set before the page is
// sliced, so it reorders every hit rather than shuffling the 15 rows you happen to be looking at.
// Client-side is right here: the hits already live in memory (acDetail.hits) and a finished check is
// a fixed snapshot, so there is nothing to re-query.
let acSort = { key: null, dir: "asc" };
const AC_SORT_KEYS = {
  input_company: (h) => (h.input_company || "").toLowerCase(),
  matched_company: (h) => (h.matched_company || "").toLowerCase(),
  title: (h) => (h.title || "").toLowerCase(),
  location: (h) => (h.location || "").toLowerCase(),
  // Lifecycle order, not alphabetical — "open" before "closed" is the useful reading.
  status: (h) => (h.status === "closed" ? 1 : 0),
  url: (h) => (h.url || "").toLowerCase(),
};
function acVisibleHits() {
  const tree = state.adv.checking;
  const hits = advHasConds(tree) ? acDetail.hits.filter(h => evalQueryTree(tree, h, !!tree.caseSensitive)) : acDetail.hits;
  const key = acSort.key && AC_SORT_KEYS[acSort.key];
  if (!key) return hits;
  const sign = acSort.dir === "asc" ? 1 : -1;
  // Copy before sorting: acDetail.hits is the live array the stream appends to, and sorting it in
  // place would reorder the source of truth as a side effect of looking at it.
  return [...hits].sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}
function acRenderResults() {
  const body = $("acResultsBody");
  const tree = state.adv.checking;
  const hits = acVisibleHits();
  if (acOffset >= hits.length) acOffset = Math.max(0, (Math.ceil(hits.length / AC_PAGE) - 1) * AC_PAGE); // filter shrank the set
  const page = hits.slice(acOffset, acOffset + AC_PAGE);
  body.innerHTML = page.length
    ? page.map(acHitRow).join("")
    : `<tr class="none"><td colspan="7">${acDetail.status === "running" ? "No matching openings yet…" : advHasConds(tree) ? "No openings match the advanced filter." : "No matching openings for these companies + filters."}</td></tr>`;
  wireSortHeaders("#acResHead", "data-acsort", () => acSort.key, () => acSort.dir,
    (k, d) => { acSort = { key: k, dir: d }; acOffset = 0; acRenderResults(); });
  const pager = $("acPager");
  if (pager) {
    pager.hidden = hits.length <= AC_PAGE;
    $("acPageInfo").textContent = hits.length ? `Showing ${acOffset + 1}–${Math.min(acOffset + AC_PAGE, hits.length)} of ${fmtNum(hits.length)}` : "";
    $("acPageNum").textContent = hits.length ? `${Math.floor(acOffset / AC_PAGE) + 1} / ${Math.ceil(hits.length / AC_PAGE)}` : "";
    $("acPagePrev").disabled = acOffset <= 0;
    $("acPageNext").disabled = acOffset + AC_PAGE >= hits.length;
  }
}
function acAppendHits(newHits) {
  if (!newHits || !newHits.length) return;
  acDetail.hits.push(...newHits);
  // A live run streams hits in. Re-render rather than appending blindly: with a pager, new rows only
  // belong on screen if they fall inside the current page, and the counts always need refreshing.
  acRenderResults();
}
function acParamsHtml(p, total) {
  const s = (p && p.search) || {};
  const kw = (s.keywords || []).filter(Boolean);
  const loc = (s.locations || []).map((l) => l.formatted_address).filter(Boolean);
  const chip = (label, val) => val ? `<span class="ac-pchip">${label}: ${esc(val)}</span>` : "";
  const list = (a) => (a && a.length) ? a.join(", ") : "";
  const domainMode = p && p.mode === "domain";
  return [
    `<span class="ac-pchip"><b>${(total || 0).toLocaleString()}</b> ${domainMode ? "domains" : "companies"}</span>`,
    `<span class="ac-pchip">${domainMode ? "By domain" : s.sourceMode === "corporate_local" ? "Companies + Local" : "Companies"}</span>`,
    domainMode && p.scrapeDescriptions ? `<span class="ac-pchip">Descriptions: on</span>` : "",
    `<span class="ac-pchip">Roles: ${kw.length ? esc(kw.join(", ")) : "any"}</span>`,
    chip("Location", loc.length ? loc.join("; ") : "anywhere"),
    chip("Workplace", list(s.workplaceTypes)), chip("Job type", list(s.commitmentTypes)),
    chip("Experience", list(s.seniorityLevels)), chip("Department", list(s.departments)),
    // A filter that is set but absent from this summary is a filter the user cannot review — they
    // read this panel to remember what a saved check actually asked for.
    chip("Industry", list(s.industries)),
    chip("Posted", s.datePostedDays ? "≤ " + s.datePostedDays + "d" : ""),
  ].filter(Boolean).join("");
}
function acRenderCounters(o) {
  const running = acDetail.status === "running";
  $("acProgWrap").style.display = running ? "block" : "none";
  if (running) {
    $("acStatus").textContent = `Checking accounts… ${(o.found || 0).toLocaleString()} hiring so far`;
    $("acNums").textContent = `${(o.checked || 0).toLocaleString()} / ${(o.total || 0).toLocaleString()}`;
    $("acBar").style.width = `${o.total ? Math.round(((o.checked || 0) / o.total) * 100) : 0}%`;
  }
  $("acSummary").textContent = o.total != null
    ? `— ${(o.found || 0).toLocaleString()} of ${(o.total || 0).toLocaleString()} companies hiring · ${(o.totalHits || 0).toLocaleString()} openings`
    : "";
}
function acSetButtons() {
  $("acStop").style.display = acDetail.status === "running" ? "inline-flex" : "none";
  $("acStop").disabled = false;
  $("acDownload").style.display = acDetail.hits.length ? "inline-flex" : "none";
}
async function acOpenDetail(id) {
  acCloseStream();
  acShow("detail");
  acDetail = { id, es: null, hits: [], status: null, counters: {} };
  $("acDName").textContent = ""; $("acDStatus").innerHTML = ""; $("acParams").innerHTML = "";
  showTableSkeleton("acResultsBody", 7, 8);
  let s;
  try {
    const r = await fetch("/api/account/searches/" + id);
    if (!r.ok) throw 0;
    s = await r.json();
  } catch { $("acResultsBody").innerHTML = `<tr class="none"><td colspan="7">Couldn't load this check.</td></tr>`; return; }
  acDetail.status = s.status;
  acDetail.mode = (s.params && s.params.mode) || "name";
  acDetail.hits = s.hits || []; acOffset = 0;
  acDetail.counters = { total: s.total, checked: s.checked, found: s.found, totalHits: s.totalHits };
  $("acDName").textContent = s.name;
  $("acDStatus").innerHTML = acStatusChip(s.status);
  $("acParams").innerHTML = acParamsHtml(s.params, s.total);
  acRenderResults(); acRenderCounters(acDetail.counters); acSetButtons();
  if (s.status === "running") acStreamDetail(id);
}
function acStreamDetail(id) {
  const es = new EventSource("/api/account/searches/" + id + "/stream");
  acDetail.es = es;
  es.addEventListener("snapshot", (e) => {
    const s = JSON.parse(e.data);
    acDetail.status = s.status; acDetail.hits = s.hits || []; acOffset = 0;
    acDetail.counters = { total: s.total, checked: s.checked, found: s.found, totalHits: s.totalHits };
    acRenderResults(); acRenderCounters(acDetail.counters); acSetButtons();
  });
  es.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    acAppendHits(p.newHits);
    acDetail.status = "running";
    acDetail.counters = { total: p.total, checked: p.checked, found: p.found, totalHits: p.totalHits };
    acRenderCounters(acDetail.counters); acSetButtons();
  });
  es.addEventListener("done", (e) => {
    es.close(); acDetail.es = null;
    acDetail.status = (JSON.parse(e.data || "{}").status) || "done";
    acFinalizeDetail();
  });
  es.addEventListener("error", (e) => {
    if (e.data) { es.close(); acDetail.es = null; acDetail.status = "error"; acFinalizeDetail(); } // server-sent run error
    // no data → transport blip; EventSource auto-reconnects and re-snapshots
  });
}
function acFinalizeDetail() {
  $("acDStatus").innerHTML = acStatusChip(acDetail.status);
  $("acProgWrap").style.display = "none";
  if (!acDetail.hits.length) acRenderResults(); // refresh placeholder wording to non-running
  acRenderCounters(acDetail.counters); acSetButtons();
  acLoadList(); // reflect the new terminal status in the list behind
}
$("acStop").onclick = async () => {
  if (!acDetail.id) return;
  $("acStop").disabled = true;
  // Re-enable on failure, or a failed stop leaves the only way to stop the run permanently greyed.
  if (!await mutate("/api/account/searches/" + acDetail.id + "/stop", { method: "POST" }, "Could not stop the check")) {
    $("acStop").disabled = false; return;
  }
  // status flips to "stopped" via the stream's done event
};
$("acDelete").onclick = async () => {
  if (!acDetail.id) return;
  if (!await uiConfirm("Delete this saved check? Its results will be removed.", { title: "Delete saved check", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/account/searches/" + acDetail.id, { method: "DELETE" }, "Could not delete that check")) return;
  acCloseStream();
  acShow("list"); acLoadList();
};
$("acDownload").onclick = () => {
  if (!acDetail.id) return;
  const a = document.createElement("a");
  a.href = "/api/account/searches/" + acDetail.id + "/export"; a.download = ""; a.click();
};

// Shared "start a one-off check + jump to its live detail". Used by BOTH the Account Check screen and
// the unified creator's "Check once" cadence, so the confirm + POST + navigate is identical for both.
// Returns the new check id, or null if the user cancelled / there were no domains. Throws on a server
// error so the caller can surface it in its own message slot.
async function startAccountCheck(name, domains, search) {
  const CAP = 10000, n = domains.length, toRun = Math.min(n, CAP);
  if (!n) return null;
  const secs = Math.ceil(toRun / 8) * 4; // one /org/ fetch per domain × ~8 parallel
  const estimate = secs <= 90 ? `under ${Math.ceil(secs / 30) * 30} seconds` : `roughly ${Math.max(1, Math.round(secs / 60))} min`;
  let warn = `Checking ${toRun.toLocaleString()} domain${toRun === 1 ? "" : "s"} — ${estimate} (already-checked domains are instant from cache).`;
  warn += ` Full job descriptions are scraped for each matched role (one extra fetch each).`;
  warn += ` Runs in the background — you can close this and come back to it.`;
  if (n > CAP) warn += `\n\nYour list has ${n.toLocaleString()}; only the first ${CAP.toLocaleString()} will be checked this run.`;
  if ((toRun > 150 || n > CAP) && !await uiConfirm(warn + "\n\nStart?", { title: "Large check", confirmLabel: "Start" })) return null;
  const payload = { name, mode: "domain", domains, search, scrapeDescriptions: true };
  const r = await fetch("/api/account/searches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok || !(r.headers.get("content-type") || "").includes("application/json")) {
    throw new Error(r.status === 404 ? "This feature isn't on the running server — restart the app to update it." : `Server error (HTTP ${r.status}).`);
  }
  const d = await r.json();
  // The pre-run warning uses a hardcoded CAP hint — the server owns the real number (ACCOUNT_MAX) and
  // reports what was ACTUALLY dropped.
  if (d.capped) toast(capNote(d), true);
  acOpenDetail(d.id); // jump to the live detail view
  return d.id;
}

// ---- run a new check (Account Check screen) ----
$("acRun").onclick = async () => {
  acUpdateCount();
  if (!acCompanies.length) return acMsg("Add at least one domain", true);
  const search = {
    keywords: lines("acKeywords"),
    keywordScope: scopeCtl("acKwScope").get(),
    exactMatch: $("acExactMatch").checked,
    exclude: lines("acExclude"),
    technologies: acTechSel.slice(),
    ...collectHcFilters("ac"),
  };
  acMsg("Starting…", false); $("acRun").disabled = true;
  try {
    const id = await startAccountCheck($("acName").value.trim(), acCompanies, search);
    if (id) $("acName").value = ""; // clear so the next new check starts fresh
  } catch (e) { acMsg(e.message || "Failed to start", true); $("acRun").disabled = false; return; }
  acMsg("", false); $("acRun").disabled = false;
};

// ================= Admin: jobs DB manager (filter / edit / delete / bulk) =================
const adm = { offset: 0, limit: 15, total: 0, sel: new Set(), editing: null, seniSel: [], techSel: [], signalSel: [], sort: null, dir: "desc" };
// Producers that expose a current-state flag → filterable as a "Company signal".
//
// This was a hand-written list of six, and it disagreed with the engine in BOTH directions at once:
//   "Running Meta ads" was offered here while adActivity returned no flag from any exit, so picking
//     it matched nothing, ever — a filter that could only ever answer "none".
//   dns, tech stack, subdomains, news, GDELT and Companies House all wrote flags, and none of them
//     could be filtered on, because they were not in this list.
// The producers now declare `flagged` themselves and /api/signals/producers serves it, so there is
// one list and it cannot drift. These six stay as the pre-fetch default only, so the control is
// never empty on first paint; loadFilterableSignals() replaces them the moment the registry lands.
let FILTERABLE_SIGNALS = [
  ["velocity", "Heavily hiring"], ["edgar", "Recently raised (SEC)"],
  ["warn", "Recent layoffs (WARN)"], ["ats", "Uses an ATS"], ["apps", "Has a mobile app"],
]; // ph (Product Hunt) is an event, not a current state → the producer opts out of `flagged`
// Short filter labels. A producer the engine adds later still appears, under its own label, rather
// than vanishing because nobody remembered to add it here.
const SIGNAL_FILTER_LABEL = {
  velocity: "Heavily hiring", ads: "Running Meta ads", edgar: "Recently raised (SEC)",
  warn: "Recent layoffs (WARN)", ats: "Uses an ATS", apps: "Has a mobile app",
  dns: "Uses an email/sending tool", tech: "Website tech detected", subdomains: "New subdomains",
  news: "In the news", gdelt: "Funding in global news", companieshouse: "UK share allotment",
};
async function loadFilterableSignals() {
  let items;
  try { items = (await fjson("/api/signals/producers")).items || []; } catch { return; } // keep the default
  // `filterable`, not `flagged`. A producer can write a current-state flag that is true for nearly
  // every domain — tech is 100%, dns 90% — and offering that as a filter returns the unfiltered
  // list, which reads as a result rather than as a filter that did nothing. Older builds of the
  // API do not send the field, so fall back to `flagged` rather than emptying the control.
  const flagged = items.filter((p) => (p.filterable ?? p.flagged));
  if (!flagged.length) return;   // a registry that answered nothing must not empty the control
  FILTERABLE_SIGNALS = flagged.map((p) => [p.key, SIGNAL_FILTER_LABEL[p.key] || p.label]);
  // Rebuild both widgets in place. The selection arrays are shared by reference, so anything already
  // ticked survives; only the option list and the trigger label repaint.
  buildMultiselect("msSignalPanel", "msSignalBtn", FILTERABLE_SIGNALS, state.signalSel, "Company signal", resetAndLoad);
  buildMultiselect("msAdmSignalPanel", "msAdmSignalBtn", FILTERABLE_SIGNALS, adm.signalSel, "Company signal", admReset);
}
const admSrcLabel = (s) => { s = String(s || "").split(":")[0]; return s === "hcorg" ? "Account/domain" : s === "hiringcafe" ? "Companies" : s; };
function admFilterObj() {
  const f = {
    q: $("admQ").value.trim() || undefined,
    fuzzy: ($("admQ").value.trim() && $("admFuzzy").checked) ? "1" : undefined,
    source: $("admSource").value || undefined,
    status: $("admStatus").value || undefined,
    hasMatches: $("admMatches").value || undefined,
    postedWithinDays: $("admSince").value || undefined,
    monitor: $("admMonitor").value || undefined,                 // jobs produced by a specific search/watchlist
    hasDescription: $("admHasDesc").value || undefined,
    seniority: adm.seniSel.length ? adm.seniSel.join(",") : undefined,
    tech: adm.techSel.length ? adm.techSel.join(",") : undefined,
    signals: adm.signalSel.length ? adm.signalSel.join(",") : undefined,
  };
  if (advHasConds(state.adv.admin)) f.adv = JSON.stringify(state.adv.admin);
  if (adm.sort) { f.sort = adm.sort; f.dir = adm.dir || "desc"; }
  return f;
}
function admFilterParams() {
  const p = new URLSearchParams(), f = admFilterObj();
  for (const k in f) if (f[k] != null) p.set(k, f[k]);
  return p;
}
async function loadAdmin(opts) {
  const tok = loadToken("admin");
  maybeSkeleton(opts, "admRows", 12, adm.limit);
  const p = admFilterParams(); p.set("limit", adm.limit); p.set("offset", adm.offset);
  let d;
  try { d = await fjson("/api/admin/jobs?" + p); }
  catch {
    if (loadStale("admin", tok)) return;
    $("admRows").innerHTML = `<tr><td colspan="12" class="skel">${BUSY_MSG}</td></tr>`; retrySoon("admin", loadAdmin); return;
  }
  if (loadStale("admin", tok)) return;
  adm.total = d.total;
  $("admEmpty").style.display = d.items.length ? "none" : "block";
  const admFilterItems = admFilterMatchItems(); // terms from the active filter → "What matched" per row
  $("admRows").innerHTML = d.items.map((r, i) => admRowHtml(r, i, admFilterItems)).join("");
  wireJdCells($("admRows"));
  wireSortHeaders("#viewAdmin thead", "data-asort", () => adm.sort, () => adm.dir,
    (k, d) => { adm.sort = k; adm.dir = d; adm.offset = 0; loadAdmin(); });
  $("admRows").querySelectorAll(".adm-cb").forEach(cb => cb.onchange = () => { cb.checked ? adm.sel.add(cb.dataset.id) : adm.sel.delete(cb.dataset.id); admPaintSel(); });
  $("admRows").querySelectorAll("[data-edit]").forEach(b => b.onclick = (e) => { e.stopPropagation(); admOpenEdit(b.dataset.edit); });
  $("admRows").querySelectorAll("[data-del]").forEach(b => b.onclick = (e) => { e.stopPropagation(); admDeleteOne(b.dataset.del, b.dataset.label); });
  // The whole row opens the record. Inner controls (checkbox, the two links, Edit/Delete, Show more)
  // must not also open it, so the handler ignores clicks that landed on something interactive.
  $("admRows").querySelectorAll("tr[data-open]").forEach(tr => {
    tr.onclick = (e) => { if (e.target.closest("a,button,input,label")) return; admOpenEdit(tr.dataset.open); };
    tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); admOpenEdit(tr.dataset.open); } };
  });
  $("admSelAll").checked = false; admPaintPager(); admPaintSel();
}
function admRowHtml(r, i, filterItems) {
  // Cells now truncate on one line rather than wrapping, so anything that can be cut carries a tooltip
  // with the full value — truncation must never be the same thing as losing the information.
  return `<tr style="--i:${i}" data-open="${esc(r.id)}" tabindex="0" role="button" aria-label="Open ${esc(r.title || "job")}${r.company ? ` at ${esc(r.company)}` : ""}">
    <td><input type="checkbox" class="adm-cb" aria-label="Select ${esc(r.title || "job")}${r.company ? ` at ${esc(r.company)}` : ""}" data-id="${esc(r.id)}" ${adm.sel.has(r.id) ? "checked" : ""}/></td>
    ${companyCellHtml(r.company, r.domain)}
    <td class="role" data-tip="${esc(r.title || "")}">${safeUrl(r.url) ? `<a href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</td>
    ${jdCell(r.description)}
    <td>${fmtSalary(r)}</td>
    <td${r.location ? ` data-tip="${esc(r.location)}"` : ""}>${esc(r.location) || '<span style="color:var(--faint)">—</span>'}</td>
    <td>${r.status === "closed" ? '<span class="chip closed">closed</span>' : '<span class="chip open">open</span>'}</td>
    <td><span class="meta">${esc(admSrcLabel(r.source))}</span></td>
    <td>${r.matchCount ? `<span class="chip client" data-tip="${esc(r.clients || "")}">${r.matchCount}</span>` : '<span style="color:var(--faint)">0</span>'}</td>
    <td class="mw-cell">${matchedWhereHtml(r, filterItems)}</td>
    <td>${fmtAgoHtml(r.postedAt)}</td>
    <td><button class="adm-act" data-edit="${esc(r.id)}">Edit</button><button class="adm-act del" data-del="${esc(r.id)}" data-label="${esc(r.title)}">Delete</button></td>
  </tr>`;
}
function admPaintPager() {
  const start = adm.total ? adm.offset + 1 : 0, end = Math.min(adm.offset + adm.limit, adm.total);
  $("admMeta").textContent = `${fmtNum(adm.total)} record${adm.total === 1 ? "" : "s"}`;
  $("admPageInfo").textContent = `Showing ${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(adm.total)}`;
  $("admPageNum").textContent = `Page ${Math.floor(adm.offset / adm.limit) + 1} of ${Math.max(1, Math.ceil(adm.total / adm.limit))}`;
  $("admPrev").disabled = adm.offset === 0; $("admNext").disabled = end >= adm.total;
}
const admPaintSel = () => { $("admSelCount").textContent = adm.sel.size ? `${adm.sel.size} selected` : ""; };
function admReset() { adm.offset = 0; adm.sel.clear(); loadAdmin(); }
// Put the Jobs database back to an unfiltered scope. admReset() only rewinds the page and the
// selection, so a drill-in that called it still inherited whatever search text, dropdowns and
// advanced conditions the user had left behind — landing on "No records" while the toast said the
// opposite. Anything that opens the view with its OWN filter must start from a clean scope.
function admClearScope() {
  $("admQ").value = "";
  $("admFuzzy").checked = false;
  for (const id of ["admSource", "admStatus", "admMatches", "admSince", "admMonitor", "admHasDesc"]) {
    const el = $(id);
    if (el) el.value = el.options[0]?.value ?? "";   // the od wrapper patches .value, so the pill repaints
  }
  delete state.adv["admin"];                          // drop any saved advanced-condition tree
  try { localStorage.setItem("se_adv", JSON.stringify(state.adv)); } catch { /* quota — not fatal */ }
  // Every multiselect, not just tech. Seniority and Company-signal were left set, so "clear
  // filters" could still land on an empty page while the toast said the scope had been reset —
  // and the pills kept showing counts for filters the user believed were gone. Rebuild each one
  // so its trigger label repaints (the arrays are shared by reference with the widgets).
  adm.techSel.length = 0; adm.seniSel.length = 0; adm.signalSel.length = 0;
  buildMultiselect("msAdmSeniorityPanel", "msAdmSeniorityBtn", SENIORITY_OPTS, adm.seniSel, "Seniority", admReset);
  buildMultiselect("msAdmSignalPanel", "msAdmSignalBtn", FILTERABLE_SIGNALS, adm.signalSel, "Company signal", admReset);
  buildTechFilter("msAdmTechPanel", "msAdmTechBtn", adm.techSel, admReset);
  adm.offset = 0; adm.sel.clear();
}
for (const id of ["admSource", "admStatus", "admMatches", "admSince"]) $(id).onchange = admReset;
let admT; $("admQ").oninput = () => { clearTimeout(admT); admT = setTimeout(admReset, 250); };
$("admFuzzy").onchange = () => { if ($("admQ").value) admReset(); };
$("admPageSize").onchange = () => { adm.limit = Number($("admPageSize").value); adm.offset = 0; loadAdmin(); };
$("techPageSize").onchange = () => { techState.limit = Number($("techPageSize").value); techState.offset = 0; techViewBrowse(); };
$("admPrev").onclick = () => { adm.offset = Math.max(0, adm.offset - adm.limit); loadAdmin(); $("admScroll")?.scrollTo({ top: 0 }); };
$("admNext").onclick = () => { adm.offset += adm.limit; loadAdmin(); $("admScroll")?.scrollTo({ top: 0 }); };
$("admSelAll").onchange = () => {
  $("admRows").querySelectorAll(".adm-cb").forEach(cb => { cb.checked = $("admSelAll").checked; cb.checked ? adm.sel.add(cb.dataset.id) : adm.sel.delete(cb.dataset.id); });
  admPaintSel();
};
async function admOpenEdit(id) {
  adm.editing = id; $("admMsg").textContent = "";
  let j;
  try { const r = await fetch("/api/admin/jobs/" + id); if (!r.ok) throw new Error("HTTP " + r.status); j = await r.json(); }
  catch { adm.editing = null; toast("Couldn't load this record — try again", true); return; } // don't open a blank/stale drawer
  $("admfTitle").value = j.title || ""; $("admfCompany").value = j.company || ""; $("admfDomain").value = j.domain || "";
  $("admfLocation").value = j.location || ""; $("admfState").value = j.state || "";
  $("admfStatus").value = j.status || "open"; $("admfRemote").value = j.remote ? "1" : "0";
  $("admfPosted").value = j.posted_at || j.postedAt || ""; $("admfUrl").value = j.url || ""; $("admfDesc").value = j.description || "";
  openDrawer("admBg", "adminDrawer", admCloseEdit);
}
const admCloseEdit = () => { closeDrawer("admBg", "adminDrawer"); };
$("admClose").onclick = admCloseEdit; $("admCancel").onclick = admCloseEdit; $("admBg").onclick = admCloseEdit;
$("admSave").onclick = async () => {
  if (!adm.editing) return;
  const body = {
    title: $("admfTitle").value, company: $("admfCompany").value || null, domain: $("admfDomain").value || null,
    location: $("admfLocation").value || null, state: $("admfState").value || null,
    status: $("admfStatus").value, remote: $("admfRemote").value === "1",
    posted_at: $("admfPosted").value || null, url: $("admfUrl").value, description: $("admfDesc").value || null,
  };
  $("admMsg").textContent = "Saving…"; $("admMsg").className = "msg";
  // No catch here meant a network failure left the drawer reading "Saving…" forever, with no way
  // to tell a slow save from a dead one.
  let res;
  try { res = await fetch("/api/admin/jobs/" + adm.editing, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { $("admMsg").textContent = "Couldn't reach the server — " + (e?.message || "try again"); $("admMsg").className = "msg err"; return; }
  if (!res.ok) { const e = await res.json().catch(() => ({})); $("admMsg").textContent = e.error || "Save failed"; $("admMsg").className = "msg err"; return; }
  $("admMsg").textContent = "Saved"; $("admMsg").className = "msg ok";
  setTimeout(admCloseEdit, 350); loadAdmin({ background: true });
};
$("admDelete").onclick = async () => {
  if (!adm.editing) return;
  if (!await uiConfirm("Delete this job record? Its matches are removed too — can't be undone.", { title: "Delete record", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/admin/jobs/" + adm.editing, { method: "DELETE" }, "Could not delete that record")) return;
  adm.sel.delete(adm.editing); admCloseEdit(); loadAdmin({ background: true });
};
async function admDeleteOne(id, label) {
  if (!await uiConfirm(`Delete "${label || "this job"}"? Its matches are removed too.`, { title: "Delete record", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/admin/jobs/" + id, { method: "DELETE" }, "Could not delete that record")) return;
  adm.sel.delete(id); loadAdmin({ background: true });
}
$("admBulkDelSel").onclick = async () => {
  if (!adm.sel.size) return toast("Select some rows first, or use “Delete all matching”.", true);
  if (!await uiConfirm(`Delete ${adm.sel.size} selected record(s)? Their matches are removed too.`, { title: "Delete selected", confirmLabel: "Delete", danger: true })) return;
  if (!await mutate("/api/admin/jobs/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...adm.sel] }) }, "Could not delete the selected records")) return;
  adm.sel.clear(); loadAdmin({ background: true });
};
$("admBulkDelAll").onclick = async () => {
  if (!adm.total) return;
  const f = admFilterObj(), noFilters = !Object.values(f).some((v) => v != null);
  if (!await uiConfirm(`Delete ALL ${adm.total.toLocaleString()} record(s) matching the current filters? Matches removed too — can't be undone.`, { title: "Delete all matching", confirmLabel: "Delete all", danger: true })) return;
  // With zero active filters the server requires an explicit all:true acknowledgment (fail-closed).
  const res = await fetch("/api/admin/jobs/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: f, all: noFilters || undefined }) });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) return toast(r.error || "Delete failed", true);
  toast(`Deleted ${fmtNum(r.removed || 0)} record(s).`); admReset();
};
async function admBulkStatus(status) {
  const useSel = adm.sel.size > 0, n = useSel ? adm.sel.size : adm.total;
  if (!n) return;
  if (!useSel && !await uiConfirm(`Mark ALL ${n.toLocaleString()} matching record(s) as ${status}?`, { title: "Bulk status change", confirmLabel: `Mark ${status}` })) return;
  const f = admFilterObj(), noFilters = !Object.values(f).some((v) => v != null);
  const body = useSel ? { status, ids: [...adm.sel] } : { status, filter: f, all: noFilters || undefined };
  const res = await fetch("/api/admin/jobs/bulk-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); return toast(e.error || "Bulk update failed", true); }
  loadAdmin({ background: true });
}
$("admBulkOpen").onclick = () => admBulkStatus("open");
$("admBulkClosed").onclick = () => admBulkStatus("closed");
$("admExport").onclick = () => { const a = document.createElement("a"); a.href = "/api/admin/jobs/export?" + admFilterParams().toString(); a.download = ""; a.click(); };

document.querySelectorAll(".side-item").forEach(b => b.onclick = () => showView(b.dataset.view));
// Collapsible sidebar (persisted)
const SB_KEY = "se_sidebar_collapsed";
if (localStorage.getItem(SB_KEY) === "1") $("sidebar").classList.add("collapsed");
$("sideCollapse").onclick = () => {
  const collapsed = $("sidebar").classList.toggle("collapsed");
  localStorage.setItem(SB_KEY, collapsed ? "1" : "0");
  $("sideCollapse").dataset.tip = collapsed ? "Expand sidebar" : "Collapse sidebar";
  $("sideCollapse").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
};
// ---- Startup / shutdown loading screens ----
function showShutdown(title, msg, done) {
  const s = $("shutScreen"); if (!s) return;
  s.style.display = "";
  void s.offsetWidth;             // force reflow so removing .hidden animates the fade-in (rAF is unreliable headless)
  s.classList.remove("hidden");
  $("shutTitle").textContent = title; $("shutMsg").textContent = msg;
  $("shutSpin").style.display = done ? "none" : ""; $("shutCheck").style.display = done ? "" : "none";
}
async function quitApp() {
  if (!await uiConfirm("Shut down HyperSignal?\n\nIn-flight account checks are saved and resume automatically next time you start the app. Scheduled monitors pause until you reopen it.", { title: "Shut down", confirmLabel: "Shut down" })) return;
  showShutdown("Shutting down…", "Saving task progress and closing background processes", false);
  try { await fetch("/api/shutdown", { method: "POST" }); } catch {}
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    try { await fetch("/api/ready", { cache: "no-store" }); }   // still responding → keep waiting
    catch { clearInterval(t); showShutdown("Closed safely", "All progress saved. You can close this window.", true); return; }
    if (tries > 60) { clearInterval(t); showShutdown("Closed safely", "You can close this window.", true); }
  }, 500);
}
$("quitBtn")?.addEventListener("click", quitApp);

// Wait for the backend to finish booting (heavy init runs after the server starts listening).
async function waitForReady() {
  for (;;) {
    try {
      const r = await (await fetch("/api/ready", { cache: "no-store" })).json();
      if (r.shuttingDown) { showShutdown("Closing…", "The app is shutting down.", false); return false; }
      if (r.ready) return true;
    } catch { /* server still coming up — keep polling */ }
    await new Promise((res) => setTimeout(res, 350));
  }
}

// ===================== Advanced filter: visual condition builder (over any field) =====================
// Mirrors src/db.ts FIELD_SQL + compileQueryTree. The SAME tree is sent to the server for the matches +
// Jobs-database views (compiled to SQL) and evaluated client-side for Account Check results (evalQueryTree).
const QB_FIELDS = [
  { key: "anytext", label: "Any text (fuzzy)", type: "fts" },
  { key: "title", label: "Title", type: "text" },
  { key: "company", label: "Company", type: "text" },
  { key: "description", label: "Description", type: "text" },
  { key: "location", label: "Location", type: "text" },
  { key: "seniority", label: "Seniority", type: "enum", options: () => HCO.seniorityLevels },
  { key: "status", label: "Status", type: "enum", options: () => ["open", "closed"] },
  { key: "source", label: "Source", type: "enum", options: () => ["hiringcafe", "hcorg", "ats:greenhouse", "ats:lever", "ats:ashby", "remoteok", "weworkremotely", "craigslist", "simplyhired"] },
  { key: "state", label: "State (US)", type: "enum", options: () => qbStateOpts },
  { key: "country", label: "Country", type: "enum", options: () => qbCountryOpts },
  { key: "industry", label: "Industry", type: "text" },
  { key: "remote", label: "Remote", type: "bool" },
  { key: "posted", label: "Posted", type: "date" },
  // NOT "($/yr)". That label was the only place left in the app still asserting a unit the data
  // does not have: the figures are as posted, in 17 different currencies, and about 30 of them are
  // hourly rates. A rule reading "salary min >= 100000" also returns 393 rows priced in INR, HUF and
  // JPY, where that is a fraction of the salary it looks like. Currency is a field now, so a rule can
  // say which one it means.
  { key: "salaryMin", label: "Salary min (as posted)", type: "number" },
  { key: "salaryMax", label: "Salary max (as posted)", type: "number" },
  { key: "currency", label: "Salary currency", type: "enum", options: () => qbCurrencyOpts },
  { key: "yoe", label: "Years of experience", type: "number" },
  { key: "companySize", label: "Company size (employees)", type: "number" },
  { key: "tools", label: "Tool / tech (raw)", type: "list" },
  { key: "tech", label: "Technology (detected)", type: "tech" },
  { key: "monitor", label: "Matched by (monitor)", type: "monitor",
    options: () => [...CONFIGS.map((c) => c.name), ...AC_MONITORS.map((a) => a.id)], // checks use their stable "ac:<id>" value
    optLabel: (v) => monitorLabel(v) },
];
const QB_FIELD = (k) => QB_FIELDS.find((f) => f.key === k) || QB_FIELDS[0];
// Clay-style plain-English operators. Text gains "contains any of" / "does not contain any of"
// (one condition, several needles) and the whole-word "is exactly".
const QB_OPS = {
  fts: [["matches", "contains the words"], ["nmatches", "does not contain the words"]],
  text: [["contains", "contains"], ["containsany", "contains any of"], ["ncontains", "does not contain"], ["ncontainsany", "does not contain any of"], ["word", "is exactly (whole word)"], ["eq", "equal to"], ["neq", "not equal to"], ["empty", "is empty"], ["nempty", "is not empty"]],
  enum: [["anyof", "is any of"], ["noneof", "is none of"], ["empty", "is empty"], ["nempty", "is not empty"]],
  bool: [["istrue", "yes"], ["isfalse", "no"]],
  date: [["withindays", "in the last N days"], ["olderdays", "older than N days"]],
  number: [["gte", "at least"], ["lte", "at most"], ["between", "between"], ["nempty", "has a value"], ["empty", "is empty"]],
  list: [["has", "includes"], ["nhas", "does not include"], ["nempty", "has any"], ["empty", "has none"]],
  tech: [["has", "includes"], ["nhas", "does not include"], ["nempty", "has any"], ["empty", "has none"]],
  monitor: [["anyof", "is any of"], ["noneof", "is none of"]],
};
let qbStateOpts = [];   // states present in scope (filled from /api/stats.byState)
let qbCountryOpts = []; // countries present in scope (filled from /api/stats.byCountry)
let qbCurrencyOpts = []; // currencies any stored salary is denominated in (/api/stats.byCurrency)
function countConds(node) { return (!node || !Array.isArray(node.children)) ? 0 : node.children.reduce((n, c) => n + (Array.isArray(c.children) ? countConds(c) : 1), 0); }
const advHasConds = (t) => countConds(t) > 0;
const newGroup = () => ({ combinator: "AND", children: [] });
const defaultOp = (type) => QB_OPS[type][0][0];
const valKind = (op) => (op === "empty" || op === "nempty" || op === "istrue" || op === "isfalse") ? "none"
  : (op === "withindays" || op === "olderdays") ? "days"
  : (op === "gte" || op === "lte") ? "num" : (op === "between") ? "range"
  : (op === "containsany" || op === "ncontainsany") ? "multi" : "scalar";

let qbScope = null, qbTree = newGroup(), qbApplyCb = null;
// opts.onApply(tree|null) captures a tree instead of filtering a view (used for a tracker's matching
// rule); opts.initialTree seeds the builder from something other than state.adv (the tracker's saved
// rule); opts.title overrides the header.
function openBuilder(scope, opts = {}) {
  qbApplyCb = opts.onApply || null;
  qbScope = scope === "matches" ? "m:" + state.kind : scope; // matches → a per-kind tree
  const seed = opts.initialTree !== undefined ? opts.initialTree : state.adv[qbScope];
  qbTree = seed ? structuredClone(seed) : newGroup();
  $("qbCase").checked = !!qbTree.caseSensitive;
  $("qbTitle").textContent = opts.title || ("Filter — " + (qbScope === "admin" ? "Jobs database" : qbScope === "checking" ? "One-off checks" : "Monitors"));
  renderQb();
  renderPresetList();
  openDrawer("qbBg", "qbDrawer", closeBuilder);
}
const closeBuilder = () => { closeDrawer("qbBg", "qbDrawer"); };

// ---- Saved filter presets (per builder scope, localStorage) ----
const loadPresets = () => { try { return JSON.parse(localStorage.getItem("se_presets") || "{}"); } catch { return {}; } };
const savePresets = (p) => localStorage.setItem("se_presets", JSON.stringify(p));
function renderPresetList() {
  const all = loadPresets()[qbScope] || {};
  const names = Object.keys(all).sort();
  $("qbPreset").innerHTML = '<option value="">Saved filters…</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  $("qbPresetDel").style.display = "none";
}
$("qbPreset").onchange = () => {
  const name = $("qbPreset").value;
  $("qbPresetDel").style.display = name ? "" : "none";
  if (!name) return;
  const preset = (loadPresets()[qbScope] || {})[name];
  if (preset?.tree) { qbTree = structuredClone(preset.tree); $("qbCase").checked = !!qbTree.caseSensitive; renderQb(); }
};
$("qbPresetSave").onclick = async () => {
  if (!countConds(qbTree)) return toast("Add at least one condition first", true);
  const name = (await uiPrompt("Save this filter as…", { placeholder: "e.g. Senior US remote w/ salary" }))?.trim();
  if (!name) return;
  qbTree.caseSensitive = $("qbCase").checked;
  const all = loadPresets(); all[qbScope] = all[qbScope] || {}; all[qbScope][name] = { tree: structuredClone(qbTree) };
  savePresets(all); renderPresetList(); $("qbPreset").value = name; $("qbPresetDel").style.display = "";
  toast(`Saved filter "${name}"`);
};
$("qbPresetDel").onclick = () => {
  const name = $("qbPreset").value; if (!name) return;
  const all = loadPresets(); if (all[qbScope]) { delete all[qbScope][name]; savePresets(all); }
  renderPresetList(); toast(`Deleted "${name}"`);
};
function renderBuilder() { const r = $("qbRoot"); r.innerHTML = ""; r.appendChild(renderGroup(qbTree, null)); }

// ============ Clay-style filter builder ============
// One clean builder (no Simple/Advanced split): linear rows with "Where / And / Or" connectors,
// friendly field groups + a type badge, plain-English operators, and "+ Add filter" / "+ Add filter
// group". Emits the same tree the SQL compiler + per-job evaluator already consume.
const treeHasGroups = (t) => (t?.children || []).some((c) => Array.isArray(c.children));
const FRIENDLY_FIELD = { anytext: "Any text", title: "Job title", description: "Description", company: "Company",
  location: "Location", state: "US state", country: "Country", remote: "Remote", seniority: "Seniority",
  salaryMin: "Salary (min)", salaryMax: "Salary (max)", currency: "Salary currency", yoe: "Years of experience",
  industry: "Industry", companySize: "Company size", source: "Source", status: "Open / closed", posted: "Posted",
  tech: "Technology (detected)", tools: "Tool / tech (raw)", monitor: "Matched by" };
const QB_FIELD_GROUPS = [
  ["What the job says", ["anytext", "title", "description", "company"]],
  ["Where", ["location", "state", "country", "remote"]],
  ["Level & pay", ["seniority", "salaryMin", "salaryMax", "currency", "yoe"]],
  ["Company", ["industry", "companySize", "source", "status", "posted"]],
  ["Technology", ["tech", "tools"]],
  ["Match source", ["monitor"]],
];
// A tiny type badge on each row's field (Clay puts a type glyph on the field). Plain characters, not
// emoji. text=T, number=#, enum=list, bool=check, date=clock, tech=code, list=list, source=house.
const TYPE_BADGE = { text: "T", fts: "T", number: "#", enum: "≡", bool: "✓", date: "◷", list: "≡", tech: "</>", monitor: "⌂" };
const qbInitVal = (t, vk) => vk === "days" ? 7 : vk === "num" ? 0 : vk === "range" ? [0, 0] : vk === "multi" ? [] : (t === "enum" || t === "monitor") ? [] : "";
const QB_STARTERS = [
  ["Remote only", () => ({ field: "remote", op: "istrue" })],
  ["Posted this week", () => ({ field: "posted", op: "withindays", value: 7 })],
  ["Senior roles", () => ({ field: "seniority", op: "anyof", value: ["Senior Level"] })],
  ["Mentions a technology…", () => ({ field: "tech", op: "has", value: "" })],
  ["Has a published salary", () => ({ field: "salaryMin", op: "nempty" })],
];

// One-click starter chips above the builder.
function renderStarters() {
  const st = $("qbStarters"); if (!st) return; st.innerHTML = "";
  for (const [label, make] of QB_STARTERS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "qb-starter"; b.textContent = "+ " + label;
    b.onclick = () => { qbTree.children.push(make()); renderQb(); };
    st.appendChild(b);
  }
}
function renderQb() { renderStarters(); renderBuilder(); }

function renderGroup(group, parent) {
  const box = document.createElement("div"); box.className = "qb-group" + (parent ? " qb-nested" : "");
  const kids = group.children || [];
  kids.forEach((child, i) => {
    const line = document.createElement("div"); line.className = "qb-line";
    // Connector: "Where" on the first row, an And/Or picker on the second (sets the group's combinator),
    // then the same word as static text on every row after — Clay's linear connector model.
    const conn = document.createElement("div"); conn.className = "qb-conn";
    if (i === 0) conn.textContent = "Where";
    else if (i === 1) {
      const sel = document.createElement("select"); sel.className = "qb-conn-sel";
      for (const [v, lbl] of [["AND", "And"], ["OR", "Or"]]) { const o = document.createElement("option"); o.value = v; o.textContent = lbl; if ((group.combinator || "AND") === v) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { group.combinator = sel.value; renderBuilder(); };
      conn.appendChild(sel);
    } else conn.textContent = (group.combinator === "OR") ? "Or" : "And";
    line.appendChild(conn);
    line.appendChild(Array.isArray(child.children) ? renderGroup(child, group) : renderCond(child, group));
    box.appendChild(line);
  });
  if (!kids.length) { const e = document.createElement("div"); e.className = "qb-empty"; e.textContent = 'No conditions yet — add a starter above, or "+ Add filter".'; box.appendChild(e); }
  const add = document.createElement("div"); add.className = "qb-add";
  const ac = document.createElement("button"); ac.type = "button"; ac.className = "qb-addbtn"; ac.textContent = "+ Add filter"; ac.onclick = () => { group.children.push({ field: "title", op: "contains", value: "" }); renderBuilder(); };
  const ag = document.createElement("button"); ag.type = "button"; ag.className = "qb-addbtn"; ag.textContent = "+ Add filter group"; ag.onclick = () => { group.children.push(newGroup()); renderBuilder(); };
  add.appendChild(ac); add.appendChild(ag);
  if (parent) { const rm = document.createElement("button"); rm.type = "button"; rm.className = "qb-addbtn qb-rmgroup"; rm.textContent = "× Remove group"; rm.onclick = () => { parent.children.splice(parent.children.indexOf(group), 1); renderBuilder(); }; add.appendChild(rm); }
  box.appendChild(add);
  return box;
}
function renderCond(cond, group) {
  const row = document.createElement("div"); row.className = "qb-cond";
  const fd = QB_FIELD(cond.field);
  // Field: a type badge + a grouped, friendly-labelled select.
  const fw = document.createElement("div"); fw.className = "qb-fieldwrap";
  const badge = document.createElement("span"); badge.className = "qb-typebadge"; badge.textContent = TYPE_BADGE[fd.type] || "T"; fw.appendChild(badge);
  const fsel = document.createElement("select"); fsel.className = "qb-field";
  for (const [grp, keys] of QB_FIELD_GROUPS) {
    const og = document.createElement("optgroup"); og.label = grp;
    for (const k of keys) {
      if (k === "monitor" && (qbScope === "checking" || qbScope === "trackerRule")) continue; // no monitor on account-check hits, nor at tracker-match time (job not yet attributed)
      const o = document.createElement("option"); o.value = k; o.textContent = FRIENDLY_FIELD[k] || k; if (k === cond.field) o.selected = true; og.appendChild(o);
    }
    if (og.children.length) fsel.appendChild(og);
  }
  fsel.onchange = () => { cond.field = fsel.value; const t = QB_FIELD(cond.field).type; cond.op = defaultOp(t); cond.value = qbInitVal(t, valKind(cond.op)); renderBuilder(); };
  fw.appendChild(fsel); row.appendChild(fw);
  // Operator: plain-English, per field type. Coerce an op the new type doesn't offer.
  const ops = QB_OPS[fd.type] || QB_OPS.text;
  if (!ops.some(([v]) => v === cond.op)) { cond.op = ops[0][0]; cond.value = qbInitVal(fd.type, valKind(cond.op)); }
  const osel = document.createElement("select"); osel.className = "qb-op";
  for (const [v, lbl] of ops) { const o = document.createElement("option"); o.value = v; o.textContent = lbl; if (v === cond.op) o.selected = true; osel.appendChild(o); }
  osel.onchange = () => { const prev = valKind(cond.op); cond.op = osel.value; const now = valKind(cond.op); if (prev !== now) cond.value = now === "none" ? undefined : qbInitVal(fd.type, now); renderBuilder(); };
  row.appendChild(osel);
  // Value
  const vk = valKind(cond.op);
  if (vk === "days" || vk === "num") { const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.value = cond.value ?? 0; inp.className = "qb-val"; inp.oninput = () => cond.value = Number(inp.value) || 0; row.appendChild(inp); }
  else if (vk === "range") {
    if (!Array.isArray(cond.value)) cond.value = [0, 0];
    const mk = (i, ph) => { const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.value = cond.value[i] ?? 0; inp.placeholder = ph; inp.className = "qb-val qb-val-sm"; inp.oninput = () => cond.value[i] = Number(inp.value) || 0; return inp; };
    row.appendChild(mk(0, "min")); const dash = document.createElement("span"); dash.textContent = "–"; dash.className = "qb-dash"; row.appendChild(dash); row.appendChild(mk(1, "max"));
  }
  else if (vk === "multi") { // "contains any of" — several needles in one condition
    if (!Array.isArray(cond.value)) cond.value = cond.value ? [String(cond.value)] : [];
    const inp = document.createElement("input"); inp.type = "text"; inp.className = "qb-val"; inp.placeholder = "value, value, …"; inp.value = cond.value.join(", ");
    inp.oninput = () => cond.value = inp.value.split(",").map((s) => s.trim()).filter(Boolean); row.appendChild(inp);
  }
  else if (vk === "scalar") {
    if (fd.type === "enum" || fd.type === "monitor") row.appendChild(qbEnumValue(cond, fd));
    else if (fd.type === "tech") row.appendChild(qbTechValue(cond));
    else { const inp = document.createElement("input"); inp.type = "text"; inp.value = cond.value ?? ""; inp.placeholder = fd.type === "list" ? "tool name…" : "value…"; inp.className = "qb-val"; inp.oninput = () => cond.value = inp.value; row.appendChild(inp); }
  }
  const rm = document.createElement("button"); rm.type = "button"; rm.className = "qb-rm"; rm.textContent = "×"; rm.dataset.tip = "Remove"; rm.setAttribute("aria-label", "Remove condition"); rm.onclick = () => { group.children.splice(group.children.indexOf(cond), 1); renderBuilder(); };
  row.appendChild(rm);
  return row;
}
function qbEnumValue(cond, fd) {
  if (!Array.isArray(cond.value)) cond.value = cond.value ? [String(cond.value)] : [];
  const opts = (fd.options ? fd.options() : []).map(String);
  const wrap = document.createElement("div"); wrap.className = "ms qb-msval";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "pill ms-btn";
  const paint = () => btn.innerHTML = `${cond.value.length ? cond.value.length + " selected" : "any…"} <span class="caret">${icon('chevron')}</span>`; paint();
  const panel = document.createElement("div"); panel.className = "ms-panel"; panel.onclick = (e) => e.stopPropagation();
  if (!opts.length) panel.innerHTML = '<div class="ms-opt" style="color:var(--faint)">no options</div>';
  for (const o of opts) { const lab = document.createElement("label"); lab.className = "ms-opt"; const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = cond.value.includes(o); cb.onchange = () => { if (cb.checked) { if (!cond.value.includes(o)) cond.value.push(o); } else cond.value = cond.value.filter((x) => x !== o); paint(); }; lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + (fd.optLabel ? fd.optLabel(o) : o))); panel.appendChild(lab); }
  btn.onclick = (e) => { e.stopPropagation(); msToggle(panel, btn); };
  wrap.appendChild(btn); wrap.appendChild(panel); return wrap;
}
// Technology value input: a text box with a live typeahead over the detected-technology dictionary
// (/api/technologies?q=). Backed by a native <datalist> so it needs no popover plumbing; the stored
// value stays free text so a name the dictionary lacks is still usable.
let qbTechListSeq = 0;
function qbTechValue(cond) {
  const wrap = document.createElement("span"); wrap.className = "qb-tech";
  const listId = "qbtl-" + (++qbTechListSeq);
  const dl = document.createElement("datalist"); dl.id = listId;
  const inp = document.createElement("input"); inp.type = "text"; inp.className = "qb-val"; inp.placeholder = "e.g. React"; inp.value = cond.value ?? ""; inp.setAttribute("list", listId); inp.autocomplete = "off";
  let t;
  inp.oninput = () => {
    cond.value = inp.value;
    const q = inp.value.trim(); clearTimeout(t);
    if (q.length < 2) { dl.innerHTML = ""; return; }
    t = setTimeout(async () => {
      try {
        const r = await (await fetch("/api/technologies?q=" + encodeURIComponent(q))).json();
        dl.innerHTML = (r.items || []).map((it) => `<option value="${esc(it.name)}">${it.category ? esc(it.category) : ""}</option>`).join("");
      } catch { /* typeahead is best-effort */ }
    }, 180);
  };
  wrap.appendChild(inp); wrap.appendChild(dl); return wrap;
}
function refreshAdvBadges() {
  const set = (id, scope) => { const b = $(id); if (b) { const n = countConds(state.adv[scope]); b.hidden = !n; b.textContent = n; } };
  set("advBadge", "m:" + state.kind); set("admAdvBadge", "admin"); set("acAdvBadge", "checking");
}
$("qbApply").onclick = () => {
  qbTree.caseSensitive = $("qbCase").checked;
  // Callback mode: the builder was opened to CAPTURE a tree (a tracker's matching rule) rather than to
  // filter a view. Hand back the tree (or null when empty) and skip the view-filter plumbing.
  if (qbApplyCb) { const cb = qbApplyCb; qbApplyCb = null; cb(countConds(qbTree) ? qbTree : null); closeBuilder(); return; }
  if (countConds(qbTree)) state.adv[qbScope] = qbTree; else delete state.adv[qbScope];
  saveAdv(); refreshAdvBadges(); closeBuilder();
  if (qbScope === "admin") admReset(); else if (qbScope === "checking") { acOffset = 0; acRenderResults(); } else resetAndLoad();
};
$("qbClear").onclick = () => { qbTree = newGroup(); $("qbCase").checked = false; renderQb(); };
$("qbCloseX").onclick = closeBuilder; $("qbBg").onclick = closeBuilder;
$("advBtn").onclick = () => openBuilder("matches");
$("admAdvBtn").onclick = () => openBuilder("admin");
$("acAdvBtn").onclick = () => openBuilder("checking");

// Quick seniority multiselects (matches + Jobs database) + admin Matched-by / Has-description selects.
const SENIORITY_OPTS = HCO.seniorityLevels.map((s) => [s, s]);
buildMultiselect("msSeniorityPanel", "msSeniorityBtn", SENIORITY_OPTS, state.seniSel, "Seniority", resetAndLoad);
buildMultiselect("msAdmSeniorityPanel", "msAdmSeniorityBtn", SENIORITY_OPTS, adm.seniSel, "Seniority", admReset);
// Technology quick-filter pills (Client/Account monitoring + Jobs database).
buildTechFilter("msTechPanel", "msTechBtn", state.techSel, resetAndLoad);
buildTechFilter("msAdmTechPanel", "msAdmTechBtn", adm.techSel, admReset);
// "Company signal" quick-filter (companies currently flagged for a sales signal) — matches + Jobs database.
buildMultiselect("msSignalPanel", "msSignalBtn", FILTERABLE_SIGNALS, state.signalSel, "Company signal", resetAndLoad);
buildMultiselect("msAdmSignalPanel", "msAdmSignalBtn", FILTERABLE_SIGNALS, adm.signalSel, "Company signal", admReset);
void loadFilterableSignals();   // swap the five-item default for whatever the engine actually flags
$("admMonitor").onchange = admReset; $("admHasDesc").onchange = admReset;

// Client-side evaluator for Account Check results (mirrors the SQL compiler semantics).
function evalQueryTree(node, hit, cs) {
  if (!node) return true;
  if (Array.isArray(node.children)) {
    if (!node.children.length) return true;
    const r = node.children.map((c) => evalQueryTree(c, hit, cs));
    return node.combinator === "OR" ? r.some(Boolean) : r.every(Boolean);
  }
  return evalCond(node, hit, cs);
}
function hitField(hit, key) {
  const raw = hit._raw || {};
  const m = {
    anytext: `${hit.title || ""} ${hit.matched_company || ""} ${hit.description || ""}`,
    title: hit.title, company: hit.matched_company, description: hit.description, location: hit.location,
    state: hit.state, status: hit.status, source: hit.source, seniority: hit.seniority, remote: hit.remote,
    posted: hit.posted_at, industry: hit.industry,
    // rich facets aren't on the account-hit shape → best-effort from raw, else null (no-op)
    salaryMin: raw.comp_min ?? null, salaryMax: raw.comp_max ?? null, yoe: raw.yoe ?? null,
    companySize: raw.employees ?? null, tools: Array.isArray(raw.tools) ? raw.tools : null,
  };
  return key in m ? m[key] : null;
}
function evalCond(c, hit, cs) {
  const ft = QB_FIELD(c.field).type;
  if (ft === "monitor") return true; // account-check hits have no monitor; server-only field
  if (ft === "tech") {
    // Account-check hits aren't tech-indexed, so approximate detection with a word-boundary match of
    // the technology name in title + description (parity gap vs the server's dictionary is noted in the
    // builder tooltip). empty/nempty can't be determined client-side → treated as a no-op (always pass).
    if (c.op === "empty" || c.op === "nempty") return true;
    const hay = `${hit.title || ""} ${hit.description || ""}`;
    const term = String(c.value || "").trim();
    if (!term) return c.op !== "has";
    const rx = new RegExp("(^|[^A-Za-z0-9+#.])" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9+#.]|$)", "i");
    const found = rx.test(hay);
    return c.op === "has" ? found : !found;
  }
  const v = hitField(hit, c.field);
  const S = (x) => x == null ? "" : String(x);
  const norm = (x) => cs ? S(x) : S(x).toLowerCase();
  const arr = Array.isArray(c.value) ? c.value.map(String) : (c.value == null || c.value === "" ? [] : [String(c.value)]);
  switch (c.op) {
    case "contains": return norm(v).includes(norm(c.value));
    case "ncontains": return !norm(v).includes(norm(c.value));
    case "containsany": { const hay = norm(v); return arr.length ? arr.some((x) => hay.includes(norm(x))) : true; }
    case "ncontainsany": { const hay = norm(v); return arr.length ? !arr.some((x) => hay.includes(norm(x))) : true; }
    case "eq": return norm(v) === norm(c.value);
    case "neq": return norm(v) !== norm(c.value);
    case "empty": return ft === "number" ? (v == null) : ft === "list" ? !(Array.isArray(v) && v.length) : S(v).trim() === "";
    case "nempty": return ft === "number" ? (v != null) : ft === "list" ? (Array.isArray(v) && v.length > 0) : S(v).trim() !== "";
    case "anyof": return !arr.length || arr.includes(S(v));
    case "noneof": return !arr.length || !arr.includes(S(v));
    case "istrue": return !!v;
    case "isfalse": return !v;
    case "gte": return v != null && Number(v) >= Number(c.value);
    case "lte": return v != null && Number(v) <= Number(c.value);
    case "between": { const [lo, hi] = Array.isArray(c.value) ? c.value : [c.value, c.value]; return v != null && Number(v) >= Number(lo) && Number(v) <= Number(hi); }
    case "has": return Array.isArray(v) && v.some((t) => norm(t) === norm(c.value));
    case "nhas": return !(Array.isArray(v) && v.some((t) => norm(t) === norm(c.value)));
    // Client-side FTS approximation (account-check hits have no index): every non-operator word must
    // appear (prefix-aware). Small parity gap vs the server's stemming — noted in the builder tooltip.
    case "matches": case "nmatches": {
      const hay = norm(v);
      const words = String(c.value || "").trim().split(/\s+/).filter(w => !/^(and|or|not)$/i.test(w)).map(w => norm(w.replace(/\*$/, "")));
      const hit = words.length > 0 && words.every(w => hay.includes(w));
      return c.op === "matches" ? hit : !hit;
    }
    case "withindays": case "olderdays": { const t = Date.parse(S(v)); if (isNaN(t)) return c.op === "withindays"; const days = (Date.now() - t) / 864e5; return c.op === "withindays" ? days <= Number(c.value) : days > Number(c.value); }
  }
  return true;
}

// The release stage shown beside the product name, read from the SERVER rather than typed into the
// HTML. A version written into markup keeps claiming whatever it said the day it was written — it
// would still read "alpha" long after this stopped being one, which is the app misstating what it
// is. The markup holds "alpha" only as the pre-fetch placeholder; this replaces it with the truth.
async function showAppVersion() {
  const el = $("appVer"); if (!el) return;
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.version) return;                    // no answer is not a reason to invent one
    const m = String(h.version).match(/-(alpha|beta|rc)\.?(\d+)?$/i);
    el.textContent = m ? (m[2] ? m[1] + " " + m[2] : m[1]) : String(h.version);
    el.setAttribute("data-tip", "Version " + h.version);
  } catch { /* leave the placeholder — a failed fetch must not blank the badge */ }
}

(async () => {
  const ok = await waitForReady();
  if (!ok) return;                         // shutting down — leave the overlay up
  const boot = $("bootScreen");
  if (boot) { boot.classList.add("hidden"); setTimeout(() => { boot.style.display = "none"; }, 400); }
  // A URL hash wins over the remembered tab, so a refresh or a shared link lands where it says.
  const hashView = (location.hash || "").replace(/^#\/?/, "").split("/")[0];
  if (hashView) {
    // The hash already says where to go — let applyHash drive the whole thing. Calling showView
    // first ran syncHash(), which rewrote "#/signals/checks" down to "#/signals" (sigTab is still
    // its "feed" default at that point) BEFORE applyHash could read the sub-tab, so every deep link
    // and every refresh on a Signals sub-tab silently landed back on Feed.
    applyHash(true);
  } else {
    showView(localStorage.getItem("se_view") || "home"); // the Accounts home; returning users keep their last tab
  }
  showAppVersion();    // the badge beside the product name, from the server's own package.json
  labelFields();       // name every .field control that only had a visual caption
  connectActivity();   // one always-on feed: shows every manual + scheduled fetch live
  refreshUnseenBadges(); // sidebar NEW badges from the last-seen watermarks
  // Config refreshes on EVERY view (the Matched-by dropdown + builder monitor options stay current);
  // loadStats writes into the monitor views' DOM, so it only runs where those elements are visible.
  setInterval(() => { loadConfig(); if (state.view === "clients" || state.view === "accounts") loadStats(); }, 60000);
})();
