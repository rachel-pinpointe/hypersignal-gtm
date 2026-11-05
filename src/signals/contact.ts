// Operator contact for outbound User-Agent strings, from the CONTACT_EMAIL environment variable.
//
// Read on every call rather than once at module load, so a value set in .env, in the shell or by a
// test always takes effect. There is deliberately no built-in default: a hardcoded address would
// attach one person's email to every request made by every copy of this code.

/** The configured contact email, or null when CONTACT_EMAIL is unset or blank. */
export function contactEmail(): string | null {
  const v = (process.env.CONTACT_EMAIL ?? "").trim();
  return v || null;
}

/** "HyperSignal-Hiring/1.0 (you@example.com)", or just "HyperSignal-Hiring/1.0" with no contact set. */
export function contactUserAgent(): string {
  const email = contactEmail();
  return email ? `HyperSignal-Hiring/1.0 (${email})` : "HyperSignal-Hiring/1.0";
}
