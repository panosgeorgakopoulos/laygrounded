// Outbound webhook signing.
//
// Two schemes ship side by side, and that is on purpose.
//
//   v1  `x-laygrounded-signature: sha256=<hmac(body)>`
//       The scheme every existing integration verifies today. It is honest
//       HMAC over the raw body, but it carries no timestamp, so a captured
//       delivery replays forever against a consumer that only checks the
//       signature.
//
//   v2  `x-laygrounded-signature-v2: t=<unix>,v1=<hmac("<t>.<body>")>`
//       The timestamped scheme (the shape Stripe and GitHub converged on).
//       Binding the timestamp INTO the signed string is what makes it
//       meaningful — a header the signature does not cover can simply be
//       rewritten by whoever replays the body.
//
// New deliveries send BOTH so existing consumers keep working while new ones
// can reject stale payloads. v1 is not removed unilaterally; that is a breaking
// change for someone else's production system and belongs in a deprecation
// window, not in a refactor.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Default replay window for v2 verification, in seconds. */
export const DEFAULT_TOLERANCE_S = 300;

/** v1: HMAC-SHA256 over the raw body. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * v2: HMAC-SHA256 over `"<unixSeconds>.<body>"`.
 *
 * The separator matters. Without it, `t=1` + body `"23{...}"` and `t=123` +
 * body `"{...}"` sign identical strings, so an attacker who can influence the
 * body can forge a different timestamp for the same signature.
 */
export function signWithTimestamp(
  body: string,
  secret: string,
  unixSeconds: number
): string {
  const t = Math.floor(unixSeconds);
  const mac = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${mac}`;
}

/** The headers to send with a signed delivery. */
export function signatureHeaders(
  body: string,
  secret: string,
  event: string,
  now: Date = new Date()
): Record<string, string> {
  const unix = Math.floor(now.getTime() / 1000);
  return {
    "content-type": "application/json",
    "x-laygrounded-event": event,
    "x-laygrounded-timestamp": String(unix),
    "x-laygrounded-signature": signBody(body, secret),
    "x-laygrounded-signature-v2": signWithTimestamp(body, secret, unix),
  };
}

/**
 * Verifies a v2 signature. Exported so our own tests — and the documentation
 * we hand a logistics partner — describe one implementation rather than two.
 *
 * Returns a reason rather than a bare false: "signature mismatch" and "this is
 * 40 minutes old" send an integrator to completely different places.
 */
export function verifySignatureV2(
  body: string,
  header: string | null,
  secret: string,
  { now = new Date(), toleranceS = DEFAULT_TOLERANCE_S }: { now?: Date; toleranceS?: number } = {}
): { valid: boolean; reason?: "malformed" | "stale" | "mismatch" | "unconfigured" } {
  if (!secret) return { valid: false, reason: "unconfigured" };
  if (!header) return { valid: false, reason: "malformed" };

  const parts = new Map<string, string>();
  for (const segment of header.split(",")) {
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    parts.set(segment.slice(0, idx).trim(), segment.slice(idx + 1).trim());
  }

  const t = parts.get("t");
  const provided = parts.get("v1");
  if (!t || !provided || !/^\d+$/.test(t)) return { valid: false, reason: "malformed" };

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(t));
  // Checked BEFORE the HMAC compare so a stale-but-correctly-signed replay is
  // reported as stale rather than as a valid delivery.
  if (skew > toleranceS) return { valid: false, reason: "stale" };

  const expected = createHmac("sha256", secret).update(`${Number(t)}.${body}`, "utf8").digest("hex");
  if (provided.length !== expected.length) return { valid: false, reason: "mismatch" };
  const ok = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
  return ok ? { valid: true } : { valid: false, reason: "mismatch" };
}
