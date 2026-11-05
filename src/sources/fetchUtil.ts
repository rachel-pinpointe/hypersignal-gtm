export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const DEFAULT_TIMEOUT = 15000;

/**
 * A page-count ceiling read from a hand-written client YAML, validated instead of coerced.
 *
 * Both adapters that took one did `Number(cfg.maxPages ?? N)` and used the result as a loop bound.
 * `Number("abc")` is NaN and `page < NaN` is false, so a stray character in a YAML made the source
 * fetch ZERO pages and return zero jobs — no error, no warning, indistinguishable from "nothing
 * matched this week". `Number("")` is 0, same outcome. SimplyHired's `Math.max(1, …)` did not help:
 * `Math.max(1, NaN)` is NaN too.
 *
 * Anything unusable falls back to the caller's default rather than to zero, and the ceiling of 500
 * stops a mistyped 100000 from turning one config line into a day-long scrape.
 */
export function pageCap(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(500, Math.floor(n));
}

export async function getText(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      ...init,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const { status, text } = await getText(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  });
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${url}`);
  return JSON.parse(text) as T;
}
