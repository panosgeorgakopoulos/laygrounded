// Audit Trail API gate: authenticate the key, enforce its scope, consume its
// quota. Every /api/v1/audit/* route goes through here.
//
// API callers hold no Supabase session, so the lookup necessarily runs on the
// service role. That makes this function the ONLY thing standing between a
// bearer token and the whole database — so it returns a companyId and every
// route scopes its queries to it. There is no path here that returns data.
//
// Failure discipline: unknown key, revoked key, expired key and malformed key
// all produce the same opaque 401. Distinguishing them would turn the
// endpoint into an oracle for which keys exist.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  bearerToken,
  hashApiKey,
  looksLikeApiKey,
  rateLimitWindow,
  type ApiScope,
} from "./keys";

export interface ApiCaller {
  keyId: string;
  companyId: string;
  label: string;
  scopes: string[];
  rateLimitPerMinute: number;
  client: SupabaseClient;
}

export class ApiAuthError extends Error {
  constructor(
    public readonly status: 401 | 403 | 429,
    public readonly code: string,
    message: string,
    // Populated for 429 so the route can set Retry-After / quota headers.
    public readonly meta?: { limit?: number; remaining?: number; resetAt?: string }
  ) {
    super(message);
    this.name = "ApiAuthError";
  }
}

const UNAUTHORIZED = () =>
  new ApiAuthError(401, "UNAUTHORIZED", "Missing or invalid API key.");

export async function authenticateApiRequest(
  req: Request,
  requiredScope: ApiScope,
  opts: { now?: Date; client?: SupabaseClient } = {}
): Promise<ApiCaller> {
  const token = bearerToken(req.headers.get("authorization"));
  // Shape check first: junk never reaches the database.
  if (!token || !looksLikeApiKey(token)) throw UNAUTHORIZED();

  const service = opts.client ?? createServiceRoleClient();
  const { data: key } = await service
    .from("api_keys")
    .select("id, company_id, label, scopes, status, rate_limit_per_minute, expires_at")
    .eq("key_hash", hashApiKey(token))
    .maybeSingle();

  if (!key || key.status !== "active") throw UNAUTHORIZED();

  const now = opts.now ?? new Date();
  if (key.expires_at && new Date(key.expires_at) <= now) throw UNAUTHORIZED();

  // Scope is a 403, not a 401: the key is real and the caller knows it. Being
  // told "this key cannot do that" is useful and leaks nothing they don't
  // already hold.
  const scopes: string[] = key.scopes ?? [];
  if (!scopes.includes(requiredScope)) {
    throw new ApiAuthError(
      403,
      "INSUFFICIENT_SCOPE",
      `This API key lacks the "${requiredScope}" scope. Granted: ${scopes.length ? scopes.join(", ") : "(none)"}.`
    );
  }

  // Quota, keyed by the API key rather than the caller's IP — an ERP behind
  // NAT is one IP for many tenants, and one tenant may call from many.
  const windowStart = rateLimitWindow(now);
  const { data: rl, error: rlErr } = await service
    .rpc("consume_api_rate_limit", {
      p_api_key_id: key.id,
      p_window_start: windowStart.toISOString(),
      p_limit: key.rate_limit_per_minute,
    })
    .single();
  // Fail CLOSED. If the limiter is unavailable we cannot know whether this
  // request is within quota, and an API that silently stops limiting under
  // database trouble is exactly what a hammering client turns into an
  // outage. 429 is the honest answer.
  if (rlErr) {
    throw new ApiAuthError(429, "RATE_LIMIT_UNAVAILABLE", "Rate limiter unavailable; request refused.", {
      limit: key.rate_limit_per_minute,
      resetAt: new Date(windowStart.getTime() + 60_000).toISOString(),
    });
  }

  const row = rl as { allowed: boolean; request_count: number };
  const resetAt = new Date(windowStart.getTime() + 60_000).toISOString();
  if (!row.allowed) {
    throw new ApiAuthError(429, "TOO_MANY_REQUESTS", "API key rate limit exceeded.", {
      limit: key.rate_limit_per_minute,
      remaining: 0,
      resetAt,
    });
  }

  // Best-effort: a failed touch must never fail the request.
  void service.from("api_keys").update({ last_used_at: now.toISOString() }).eq("id", key.id);

  return {
    keyId: key.id,
    companyId: key.company_id,
    label: key.label,
    scopes,
    rateLimitPerMinute: key.rate_limit_per_minute,
    client: service,
  };
}

// Standard quota headers so an integrator can back off before being refused.
export function rateLimitHeaders(caller: ApiCaller, now: Date = new Date()): Record<string, string> {
  const resetAt = new Date(rateLimitWindow(now).getTime() + 60_000);
  return {
    "X-RateLimit-Limit": String(caller.rateLimitPerMinute),
    "X-RateLimit-Reset": String(Math.floor(resetAt.getTime() / 1000)),
  };
}
