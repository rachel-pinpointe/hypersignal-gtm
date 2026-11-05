// SSRF guard for fetching URLs that originate from scraped/external data (e.g. job-posting URLs we
// re-check in the verify sweep). Two attack surfaces are closed:
//   1. A stored URL that points straight at an internal host (localhost, cloud metadata, RFC-1918).
//   2. An external URL that 30x-redirects to an internal host — so we follow redirects MANUALLY and
//      re-validate every hop instead of trusting fetch's redirect:"follow".
// Residual caveat: a resolve-then-fetch check can be defeated by DNS rebinding (attacker DNS with a
// sub-second TTL flipping the answer between our lookup and fetch's). That needs attacker-controlled
// DNS + precise timing and is out of scope for re-checking public job-board links; pinning the
// resolved IP would need a custom undici dispatcher. Documented, not silently ignored.
import dns from "node:dns/promises";
import net from "node:net";

/** True if an IP literal falls in a loopback / link-local / private / CGNAT range (v4 or v6). */
export function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const a = p[0]!, b = p[1]!;
    if (a === 0 || a === 10 || a === 127) return true;         // "this host" / private / loopback
    if (a === 169 && b === 254) return true;                    // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT (RFC 6598)
    if (a === 192 && b === 0 && p[2] === 0) return true;         // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;        // 198.18.0.0/15 benchmarking
    if (a >= 224) return true;                                   // multicast 224/4 + reserved 240/4 + broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lo === "::1" || lo === "::") return true;               // loopback / unspecified
    if (lo.startsWith("fe80")) return true;                     // link-local
    if (lo.startsWith("fc") || lo.startsWith("fd")) return true; // unique-local
    if (/^fe[c-f]/.test(lo)) return true;                        // fec0::/10 site-local (deprecated, still routed by some stacks)
    if (lo.startsWith("64:ff9b:")) return true;                  // NAT64 well-known prefix — every address behind it lands on IPv4
    // IPv4 embedded in an IPv6 literal. ::ffff:a.b.c.d (IPv4-mapped) was already handled; ::a.b.c.d
    // (IPv4-compatible, deprecated but still parsed by getaddrinfo) was NOT, so "::127.0.0.1" walked
    // straight through this guard.
    const embedded = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lo);
    if (embedded) return ipIsPrivate(embedded[1]!);
    return false;
  }
  return true; // unparseable → treat as unsafe
}

/** Parse + validate a URL: http(s) only, and its host must not resolve to a private/internal IP. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked protocol ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) { if (ipIsPrivate(host)) throw new Error("blocked private ip"); return; }
  // dns.lookup() resolves via libuv's threadpool (default size 4, process-wide -- shared with every
  // other async fs/crypto/zlib call in the whole process), which is fine for a handful of calls but
  // not for a guard that runs on nearly every producer fetch across a ~1,445-domain watchlist. Found
  // live 2026-09-18 while chasing a scheduled-cron stall (every producer for nearly every domain
  // timing out after the first couple, though curl from that same environment worked fine and nothing
  // reproduced in direct testing): a 60-domain concurrent dns.lookup({all:true}) benchmark took ~3s
  // end-to-end vs ~60ms for the identical domains via dns.resolve4 -- a ~50x gap from pure 4-thread
  // queueing, with no code bug and no genuinely slow domain involved. At real scale, with every
  // domain's company-resolve plus several producers' own fetches all funneling through the same 4
  // threads, that queueing compounds -- and a handful of domains with slow or stalled dual-stack
  // (A+AAAA) resolution in a given environment could occupy all 4 slots and back up every other
  // DNS-dependent call in the process behind them. dns.resolve4/resolve6 go through c-ares directly,
  // bypassing the threadpool entirely, and (unlike dns.lookup) don't need the OS's own getaddrinfo to
  // finish a dual-stack query before returning. This does not by itself confirm the threadpool was
  // THE cause of that stall (unproven -- see the diagnostic logging added to run-signals-once.mts the
  // same day); it is a real, separately-justified fix either way.
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  const addrs = [...v4, ...v6];
  if (!addrs.length) throw new Error("host does not resolve");
  for (const a of addrs) if (ipIsPrivate(a)) throw new Error("host resolves to private ip");
}

/** fetch() for a URL the machine's owner typed themselves — webhook sinks. Deliberately does NOT
 *  apply the private-IP rule to the host they entered: a local n8n, Home Assistant or LAN endpoint
 *  is a perfectly normal webhook target for a desktop tool, and refusing it would break real setups
 *  to fix a threat the owner already controls. What IS enforced: http(s) only, and a redirect may
 *  not leave the host they typed — so a public endpoint cannot bounce the request onto the LAN. */
export async function ownerFetch(raw: string, opts: RequestInit & { maxRedirects?: number } = {}): Promise<Response> {
  const { maxRedirects = 3, ...init } = opts;
  let start: URL;
  try { start = new URL(raw); } catch { throw new Error("invalid url"); }
  if (start.protocol !== "http:" && start.protocol !== "https:") throw new Error(`blocked protocol ${start.protocol}`);
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resp = await fetch(url, { ...init, redirect: "manual" });
    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
    if (!loc) return resp;
    const next = new URL(loc, url);
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("blocked redirect protocol");
    if (next.host !== start.host) throw new Error(`webhook redirected off-host (${start.host} → ${next.host})`);
    url = next.toString();
  }
  throw new Error("too many redirects");
}

/** fetch() that (a) validates the target host is public and (b) follows redirects manually, re-running
 *  the same check on every hop. Rejects (throws) for a blocked host/protocol/redirect. */
export async function safeFetch(raw: string, opts: RequestInit & { maxRedirects?: number } = {}): Promise<Response> {
  const { maxRedirects = 5, ...init } = opts;
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(url);
    const resp = await fetch(url, { ...init, redirect: "manual" });
    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
    if (!loc) return resp;
    url = new URL(loc, url).toString(); // resolve relative redirects against the current hop
  }
  throw new Error("too many redirects");
}
