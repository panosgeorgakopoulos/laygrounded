// OAuth 2.1 credential primitives — the pure half. No I/O, no Supabase.
//
// Everything here is either a generator of high-entropy random strings or a
// constant-time comparison, and all of it is unit-tested, because this is the
// code an attacker attacks. The database (src/lib/oauth/store.ts) stores only
// the SHA-256 hashes these produce; the plaintext is shown once and never
// again, exactly as api_keys already does (AD-035): 256-bit random tokens have
// no dictionary to slow, and the token path runs on every MCP request, so a
// KDF here would be a self-inflicted DoS, not security.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Prefixes make a leaked credential identifiable in a log without revealing
// anything — and keep the three token types distinguishable at a glance.
export const AUTH_CODE_PREFIX = "lgoauth_code_";
export const ACCESS_TOKEN_PREFIX = "lgoauth_at_";
export const REFRESH_TOKEN_PREFIX = "lgoauth_rt_";
export const CLIENT_ID_PREFIX = "lgmcp_";
export const CLIENT_SECRET_PREFIX = "lgcs_";

// 32 bytes = 256 bits of entropy, base64url. Guessing is not a threat model.
const TOKEN_BYTES = 32;

// Lifetimes. The authorization code lives only for the redirect hop; the
// access token is short so a leak is self-limiting; the refresh token is the
// long-lived credential and is single-use with rotation (see the store).
export const AUTH_CODE_TTL_SECONDS = 60; // one minute — a code is used at once
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // one hour
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // thirty days

export interface GeneratedCredential {
  plaintext: string; // returned to the client exactly once
  hash: string; // what the database stores
}

function randomToken(prefix: string): GeneratedCredential {
  const plaintext = `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { plaintext, hash: sha256(plaintext) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const generateAuthCode = () => randomToken(AUTH_CODE_PREFIX);
export const generateAccessToken = () => randomToken(ACCESS_TOKEN_PREFIX);
export const generateRefreshToken = () => randomToken(REFRESH_TOKEN_PREFIX);

// A client id is a public identifier, not a secret — so no hash, just entropy
// enough to be unguessable and unique.
export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString("base64url")}`;
}

// Confidential clients get a secret; public clients (installed apps) do not.
export function generateClientSecret(): GeneratedCredential {
  return randomToken(CLIENT_SECRET_PREFIX);
}

// Constant-time string compare over the hex hashes. A byte-by-byte early-exit
// comparison leaks, through timing, how much of a guess was correct.
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

// RFC 7636 §4.1: 43–128 chars from the unreserved set. The client generates
// this; we validate the shape of what it later presents so a malformed
// verifier is rejected as a bad request rather than silently failing the
// hash compare.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && VERIFIER_RE.test(verifier);
}

// A well-formed S256 challenge is the base64url of a 32-byte digest: 43 chars,
// no padding, unreserved alphabet. Checked at /authorize so a broken challenge
// fails when the flow starts, not one redirect later at /token.
const CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43}$/;

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

/** S256 transform: BASE64URL(SHA256(ASCII(verifier))). */
export function deriveS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * PKCE proof: does this verifier hash to the challenge stored with the code?
 *
 * S256 only — 'plain' is neither accepted here nor allowed by the schema,
 * because a plain challenge equals the verifier and proves nothing against an
 * attacker who saw the authorization request. The comparison is constant-time.
 */
export function verifyPkce(verifier: string, storedChallenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  return safeEqualHex(deriveS256Challenge(verifier), storedChallenge);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Space-delimited scope string → a de-duplicated, order-stable list. */
export function parseScope(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

export function serialiseScope(scopes: string[]): string {
  return [...new Set(scopes)].join(" ");
}

/**
 * The granted scope may only ever NARROW. A token request that names a scope
 * the client was not registered for, or the user did not consent to, gets the
 * intersection — never the union. Returns the requested scopes filtered to
 * those in `allowed`, preserving the requester's order.
 */
export function narrowScope(requested: string[], allowed: string[]): string[] {
  const permit = new Set(allowed);
  return requested.filter((s) => permit.has(s));
}
