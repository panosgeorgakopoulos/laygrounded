// Shared response shaping for the Audit Trail API.
//
// One error envelope across every endpoint: integrators write one handler,
// not seven. Quota headers ride on both success and failure so a client can
// back off before it is refused rather than after.

import { NextResponse } from "next/server";
import { ApiAuthError, rateLimitHeaders, type ApiCaller } from "./authenticate";

export function apiOk(
  body: unknown,
  caller: ApiCaller,
  init: { status?: number; headers?: Record<string, string> } = {}
): NextResponse {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { ...rateLimitHeaders(caller), ...(init.headers ?? {}) },
  });
}

export function apiFail(status: number, code: string, message: string, extra?: unknown): NextResponse {
  return NextResponse.json({ error: code, message, ...(extra ? { details: extra } : {}) }, { status });
}

// Turns an auth/scope/quota failure into its response. Anything else is a
// genuine server fault and must not leak its message to an API client.
export function apiAuthFailure(e: unknown, context: string): NextResponse {
  if (e instanceof ApiAuthError) {
    const headers: Record<string, string> = {};
    if (e.meta?.limit !== undefined) headers["X-RateLimit-Limit"] = String(e.meta.limit);
    if (e.meta?.remaining !== undefined) headers["X-RateLimit-Remaining"] = String(e.meta.remaining);
    if (e.meta?.resetAt) {
      headers["X-RateLimit-Reset"] = String(Math.floor(new Date(e.meta.resetAt).getTime() / 1000));
      if (e.status === 429) {
        const secs = Math.max(1, Math.ceil((new Date(e.meta.resetAt).getTime() - Date.now()) / 1000));
        headers["Retry-After"] = String(secs);
      }
    }
    // 401 must advertise the scheme it expects (RFC 7235).
    if (e.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="LayGrounded Audit Trail API"';
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers });
  }
  console.error(`[${context}]`, e);
  return NextResponse.json(
    { error: "INTERNAL_ERROR", message: "An unexpected server error occurred." },
    { status: 500 }
  );
}
