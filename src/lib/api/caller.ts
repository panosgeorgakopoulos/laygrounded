// Dual authentication: one resolver that accepts either a logged-in session or
// a B2B API key, so a route's business logic is written once and serves both
// the web app and third-party integrators.
//
// THE LOAD-BEARING RULE, AND THE REASON THIS FILE EXISTS SEPARATELY:
//
//   If the request presents an Authorization header, it is an API-KEY request,
//   FULL STOP. A bad key never falls back to the session cookie.
//
// The tempting implementation — "try the key, and if that fails try the
// session" — is a privilege-escalation bug. A browser holding a valid session
// cookie also sends that cookie on every fetch. An integrator testing a revoked
// or wrong-scoped key from inside a logged-in browser tab would silently
// succeed with the *user's* full privileges, and the key's scope and quota
// would never apply. The failure would look like the API working.
//
// So: the presence of an Authorization header selects the mechanism, and the
// selected mechanism either authorises the request or fails it.
//
// Scopes and quotas apply to keys only. A session is a human acting as
// themselves — already bounded by RLS and by the per-IP ceiling in proxy.ts —
// and has no scope list to check against.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { authenticateApiRequest, ApiAuthError, type ApiCaller } from "./authenticate";
import { rateLimitWindow, type ApiScope } from "./keys";

export type CallerKind = "session" | "api_key";

export interface ResolvedCaller {
  kind: CallerKind;
  /** The tenant every query in the route must be scoped to. */
  companyId: string;
  /**
   * The tenant's name, resolved for both mechanisms so this is a drop-in for
   * `requireAuth()`. Routes that put the company on a generated artefact (an
   * MRV report, a dossier) need it, and an API key carries no session to
   * supply it.
   */
  companyName: string;
  /** The acting user, when there is one. Null for API keys — a key is not a person. */
  userId: string | null;
  /** Granted scopes. Null for sessions, which are not scope-limited. */
  scopes: string[] | null;
  /** Set for API keys, for quota headers and audit. */
  keyId: string | null;
  rateLimitPerMinute: number | null;
  /**
   * A client that can read the tenant's data.
   *
   * For a session this is the cookie client, still under RLS. For an API key it
   * is the SERVICE-ROLE client, because a key holder has no Supabase session
   * for RLS to act on — which is exactly why `companyId` above is not optional
   * and every route must filter by it.
   */
  client: SupabaseClient;
}

/** True when the caller presented an API key rather than relying on a session. */
export function isApiKeyRequest(req: Request): boolean {
  return (req.headers.get("authorization") ?? "").trim().length > 0;
}

/**
 * Resolves the caller of a dual-auth route.
 *
 * `scope` is the scope an API key must hold. It is ignored for sessions.
 * Throws `ApiAuthError` (401/403/429) for key failures and the usual
 * `UNAUTHORIZED` / `NO_COMPANY` sentinels for session failures, so existing
 * `apiError()` handling keeps working unchanged.
 */
export async function resolveCaller(
  req: Request,
  scope: ApiScope,
  opts: { now?: Date; client?: SupabaseClient } = {}
): Promise<ResolvedCaller> {
  if (isApiKeyRequest(req)) {
    const caller: ApiCaller = await authenticateApiRequest(req, scope, opts);
    // One extra read, on the already-authorised company only. Falls back to the
    // key's label rather than failing the request: a missing company name is a
    // cosmetic problem, and refusing an authenticated call over one would be
    // the wrong trade.
    const { data: company } = await caller.client
      .from("companies")
      .select("name")
      .eq("id", caller.companyId)
      .maybeSingle();
    return {
      kind: "api_key",
      companyId: caller.companyId,
      companyName: company?.name ?? caller.label,
      userId: null,
      scopes: caller.scopes,
      keyId: caller.keyId,
      rateLimitPerMinute: caller.rateLimitPerMinute,
      client: caller.client,
    };
  }

  const auth = await requireAuth();
  return {
    kind: "session",
    companyId: auth.companyId,
    companyName: auth.companyName,
    userId: auth.userId,
    scopes: null,
    keyId: null,
    rateLimitPerMinute: null,
    client: await createClient(),
  };
}

/**
 * Quota headers for a resolved caller. Empty for sessions — there is no
 * per-key quota to report, and emitting zeros would tell an integrator their
 * key was throttled when no key was used.
 */
export function callerRateLimitHeaders(
  caller: ResolvedCaller,
  now: Date = new Date()
): Record<string, string> {
  if (caller.kind !== "api_key" || caller.rateLimitPerMinute === null) return {};
  const resetAt = new Date(rateLimitWindow(now).getTime() + 60_000);
  return {
    "X-RateLimit-Limit": String(caller.rateLimitPerMinute),
    "X-RateLimit-Reset": String(Math.floor(resetAt.getTime() / 1000)),
  };
}

export { ApiAuthError };
