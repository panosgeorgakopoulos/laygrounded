// Audit Trail API keys — the pure half.
//
// Keys are 192 bits of CSPRNG output, base64url, behind an `lga_` prefix
// (LayGrounded Audit; the insurer oracle's keys use `lgk_` and live in their
// own table — the prefixes keep the two surfaces distinguishable in a log or
// a support ticket).
//
// Only the SHA-256 hash is ever stored. SHA-256 rather than bcrypt/argon2 is
// deliberate: these are high-entropy random tokens, not user-chosen
// passwords. There is no dictionary to slow an attacker down, so a KDF buys
// nothing — and this path runs on every single API request, where a
// deliberately slow hash would be a self-inflicted DoS. (The same reasoning
// the insurer oracle already applies.)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "lga_";
// 24 bytes → 32 base64url chars. Long enough that guessing is hopeless,
// short enough to paste into an ERP config field.
const KEY_BYTES = 24;

// Least privilege, and deliberately granular: a TMS that only pulls
// calculations gets no write scope, and a trade-finance reader gets neither.
//
// NOTE ON WHAT IS ABSENT: there is no `keys:manage` scope, and there must not
// be. Key management is session-only. A scope that lets a key mint or widen
// another key turns one leaked credential into permanent, self-renewing
// access — the blast radius of a leak should be "revoke it", not "it already
// made three more".
export const API_SCOPES = [
  "voyages:write", // push voyage/SoF data in
  "calculations:read", // pull laytime calculations
  "calculations:write", // trigger a recompute
  "disputes:read", // pull dispute / proposal status
  "pnl:read", // pull voyage P&L snapshots
  "documents:read", // pull dossiers, notarization records, exports
  "compliance:read", // pull MRV / emissions / sanctions results
  "webhooks:manage", // register and remove webhooks
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

export interface GeneratedApiKey {
  // Shown once, never stored.
  plaintext: string;
  hash: string;
  // Non-secret fragment for display: "lga_ab12cd34".
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashApiKey(plaintext), prefix: apiKeyPrefix(plaintext) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// First 8 chars of the random part, after the scheme prefix. Enough to
// identify a key in a list; useless to an attacker.
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 8);
}

// Shape check only — never a claim that the key is valid. Cheap rejection of
// obvious junk before touching the database.
export function looksLikeApiKey(key: string): boolean {
  if (!key.startsWith(API_KEY_PREFIX)) return false;
  const body = key.slice(API_KEY_PREFIX.length);
  return body.length >= 16 && body.length <= 128 && /^[A-Za-z0-9_-]+$/.test(body);
}

// Extracts the bearer token. Accepts only the `Bearer` scheme: an API that
// silently accepts a bare token teaches integrators to send credentials in
// ways proxies and logs treat differently.
export function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return m ? m[1] : null;
}

// Constant-time compare for hex digests. The DB lookup is by hash so this is
// belt-and-braces, but any place two secrets are compared should not leak
// timing.
export function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hasScope(granted: string[], required: ApiScope): boolean {
  return granted.includes(required);
}

// The window a timestamp falls in, truncated to the minute. Both the limiter
// and its tests derive the window here so they cannot disagree about where a
// boundary is.
export function rateLimitWindow(at: Date): Date {
  const w = new Date(at);
  w.setUTCSeconds(0, 0);
  return w;
}
