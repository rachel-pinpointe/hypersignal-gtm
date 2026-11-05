// Route-level contract tests against a REAL server on an ephemeral port.
//
// server.ts is the largest file in the app and had no tests, because gracefulShutdown ends in
// process.exit(0) and there was no other way to stop a server once started. startServer now returns
// the http.Server, which is all this needed.
//
// Two things are pinned here, chosen because both fail SILENTLY and both protect something real:
//
//  1. THE LOOPBACK GUARD. This dashboard has no login. Every route is fully trusted and several are
//     destructive with no confirmation (purge-old, bulk delete, shutdown). The only thing making
//     that safe is that it binds to loopback, with a Host check on top to stop DNS rebinding — a
//     hostile page resolving its own name to 127.0.0.1 to become same-origin with us. If that guard
//     ever stops rejecting a foreign Host, nothing breaks, nothing logs, and the app is wide open to
//     any page the user visits.
//
//  2. THE CSV EXPORTS. Four of them, written independently, and they have drifted before — three of
//     six export endpoints were fixed in one pass earlier and the other three were missed precisely
//     because nobody had enumerated them. A header row and the right content type is the floor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, markReady } from "./server.ts";

const srv = startServer(0);                       // 0 = let the OS pick a free port
// listen() is asynchronous: address() is null until the socket is actually bound, so reading the
// port synchronously throws. Wait for the event (or reuse it if binding already completed).
if (!srv.listening) await new Promise<void>((r) => srv.once("listening", () => r()));
const port = (srv.address() as AddressInfo).port;
// Data routes answer 503 until the boot migration finishes — the honest answer while the database is
// still being prepared, rather than a wrong number. index.ts calls this once init completes.
markReady();
after(() => { srv.close(); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; text: string }

/** Raw node:http, NOT fetch. undici treats Host as a forbidden header and silently sends the real
 *  one, so a fetch-based version of the DNS-rebinding test passes no matter what the guard does —
 *  it was green against a server that had never seen the foreign Host at all. */
const get = (path: string, headers: Record<string, string> = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
    req.on("error", reject);
    req.end();
  });
const header = (r: Res, k: string) => String(r.headers[k] ?? "");

test("the server answers on loopback", async () => {
  const res = await get("/api/ready");
  assert.equal(res.status, 200);
});

test("a foreign Host header is refused — this is the DNS-rebinding lock", async () => {
  // A hostile page cannot change the socket it reaches, but it CAN make the browser send its own
  // hostname. That is the whole attack this check exists for.
  const res = await get("/api/ready", { Host: "evil.example.com" });
  assert.equal(res.status, 403, "a non-local Host must be rejected");
  assert.match(res.text, /only accepts requests from this computer/i);
});

test("a cross-site Origin is refused", async () => {
  // <img>/<script>/form GETs send no Origin at all and a sandboxed iframe sends the literal "null",
  // so the guard cannot simply trust "an Origin that is not null".
  for (const origin of ["https://evil.example.com", "null"]) {
    const res = await get("/api/ready", { Origin: origin });
    assert.equal(res.status, 403, `Origin: ${origin} must be rejected`);
  }
});

test("every CSV export returns a header row and a CSV content type", async () => {
  // Enumerated from the source rather than remembered — the last drift here happened because three
  // endpoints were fixed and three were never listed.
  const exports = ["/api/matches/export", "/api/signals/export", "/api/companies/export", "/api/admin/jobs/export"];
  for (const path of exports) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
    assert.match(header(res, "content-type"), /text\/csv/, `${path} content-type`);
    assert.match(header(res, "content-disposition"), /attachment; filename=/, `${path} must download`);
    const head = res.text.split("\n")[0] ?? "";
    assert.ok(head.includes(","), `${path} has no header row (got ${JSON.stringify(head.slice(0, 80))})`);
    // An export that silently truncates is a failure mode this app has already had once.
    assert.equal(res.headers["x-hypersignal-truncated"], undefined, `${path} must not advertise truncation`);
  }
});

test("the signals CSV header carries the parity columns", async () => {
  const head = (await get("/api/signals/export")).text.split("\n")[0] ?? "";
  for (const col of ["when", "first_seen", "evidence_rank", "reports_grouped", "matched_by"])
    assert.ok(head.includes(col), `signals CSV header is missing ${col}: ${head}`);
});

test("an unknown API path 404s rather than falling through to the SPA", async () => {
  // A misrouted /api/* that returns index.html gives the client HTML where it expects JSON, and the
  // symptom is a confusing parse error far from the cause.
  const res = await get("/api/definitely-not-a-route");
  assert.equal(res.status, 404);
});
