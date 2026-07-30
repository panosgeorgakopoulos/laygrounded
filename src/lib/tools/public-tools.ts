// Shared plumbing for the unauthenticated marketing tools.
//
// THE BOUNDARY THIS FILE EXISTS TO HOLD: a public tool may use the pure engine
// and the public weather archive, and NOTHING ELSE. It never reads a claim, a
// company, a calculation or a tenant's cargo profile. The only rows it touches
// are its own usage counter and lead table.
//
// That is why the tool routes import from here rather than from the claim
// modules: the separation is visible in the import graph, so a future change
// that reached into tenant data would look wrong on sight rather than merely
// being wrong.

import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Free queries per IP per UTC day. Deliberately small — this is a demo, not a service. */
export const PUBLIC_TOOL_DAILY_LIMIT = 3;

/**
 * Salt for IP hashing.
 *
 * A bare SHA-256 of an IPv4 address is reversible by brute force in seconds —
 * there are only 4 billion of them — so an unsalted hash would be personal data
 * wearing a disguise. A per-deployment salt makes the stored value useless
 * outside this database.
 *
 * Falls back to a process-lifetime random value when unset, which degrades
 * gracefully: counting still works within an instance, and no weak hash is ever
 * persisted across deployments.
 */
const IP_SALT = process.env.PUBLIC_TOOL_IP_SALT || randomBytes(16).toString("hex");

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex");
}

/**
 * Best available client IP.
 *
 * `x-forwarded-for` is client-controlled, so this is a rate-limiting signal and
 * not an identity. Someone determined can rotate it; the limit exists to stop
 * casual scripts and accidental loops, and the honest framing matters — this is
 * not a security control and must never be treated as one.
 */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  /** Seconds until the counter resets (next UTC midnight). */
  resetInSeconds: number;
}

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Consumes one unit of a caller's daily allowance.
 *
 * Atomic: the upsert increments and returns the new count in one statement, so
 * two simultaneous requests cannot both read "2 used" and both proceed.
 *
 * FAILS OPEN, unlike the authenticated API's limiter which fails closed. The
 * trade is deliberate and runs the other way here: refusing a prospective
 * customer because our counter table hiccuped costs a lead, while letting a few
 * extra free queries through costs two upstream calls. The authenticated API
 * protects a paid resource; this protects a demo.
 */
export async function consumePublicQuota(
  service: SupabaseClient,
  ipHash: string,
  tool: string,
  now: Date = new Date(),
  limit: number = PUBLIC_TOOL_DAILY_LIMIT
): Promise<QuotaResult> {
  const day = now.toISOString().slice(0, 10);
  const reset = secondsToUtcMidnight(now);

  // One statement: insert-or-increment, returning the new count. Two concurrent
  // requests cannot both observe "2 used" and both proceed.
  const { data, error } = await service.rpc("increment_public_tool_usage", {
    p_ip_hash: ipHash,
    p_day: day,
    p_tool: tool,
  });

  if (error || typeof data !== "number") {
    return { allowed: true, used: 0, limit, resetInSeconds: reset };
  }

  return { allowed: data <= limit, used: data, limit, resetInSeconds: reset };
}

/** Basic shape check. Deliberately permissive — we are capturing leads, not validating identity. */
export function isPlausibleWorkEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(trimmed);
}

/** Consumer mailboxes, so the UI can nudge toward a work address without refusing one. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
]);

export function isConsumerDomain(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return CONSUMER_DOMAINS.has(domain);
}
