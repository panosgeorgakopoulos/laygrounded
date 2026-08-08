import { NextResponse } from "next/server";

// Error messages that are safe to return to the client, mapped to the HTTP
// status they should carry. These are deliberate, non-sensitive business
// conditions (auth, validation, not-found, conflict). Anything NOT in this
// table is treated as an unexpected server fault: the full error and stack are
// logged server-side for debugging, and the client receives only an opaque,
// generic message so internal details never leak.
const DEFAULT_KNOWN: Record<string, number> = {
  UNAUTHORIZED: 401,
  NO_COMPANY: 401,
  FORBIDDEN: 403,
  CLAIM_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  DOC_NOT_FOUND: 404,
  COMPANY_NOT_FOUND: 404,
  NO_NOR: 400,
  NO_CP_TERMS: 400,
  INVALID_CP_TERMS: 400,
  VALIDATION_ERROR: 400,
  ALREADY_MEMBER: 409,
  USER_ALREADY_IN_ANOTHER_COMPANY: 409,
  CANNOT_REMOVE_SELF: 400,
  MEMBER_NOT_FOUND: 404,
  // Demoting or removing the last admin would leave the tenant unable to manage
  // its own team, with no self-service way back.
  LAST_ADMIN: 409,
};

export const GENERIC_ERROR_MESSAGE = "An unexpected server error occurred";

interface ApiAuthErrorShape {
  name: string;
  status: 401 | 403 | 429;
  code: string;
  message: string;
  meta?: { limit?: number; remaining?: number; resetAt?: string };
}

function isApiAuthErrorShape(e: unknown): e is ApiAuthErrorShape {
  if (!(e instanceof Error) || e.name !== "ApiAuthError") return false;
  const status = (e as unknown as { status?: unknown }).status;
  const code = (e as unknown as { code?: unknown }).code;
  return (status === 401 || status === 403 || status === 429) && typeof code === "string";
}

/** Retry-After on a 429, so a throttled integrator backs off instead of spinning. */
function retryHeaders(e: ApiAuthErrorShape): Record<string, string> {
  if (e.status !== 429 || !e.meta?.resetAt) return {};
  const seconds = Math.max(1, Math.ceil((new Date(e.meta.resetAt).getTime() - Date.now()) / 1000));
  return { "Retry-After": String(seconds) };
}

/**
 * Converts a thrown error into a safe JSON response.
 *
 * - Recognized business errors (see DEFAULT_KNOWN, plus any `extraKnown`
 *   passed by the caller) are returned verbatim with their mapped status.
 * - Everything else is logged in full server-side (message + stack) and
 *   returned to the client as a generic 500, so stack traces and internal
 *   messages are never exposed.
 */
export function apiError(
  error: unknown,
  context: string,
  extraKnown: Record<string, number> = {}
): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const known = { ...DEFAULT_KNOWN, ...extraKnown };

  // Dual-authenticated routes reject API keys by throwing ApiAuthError, which
  // already carries the right status and a code the caller can act on. Without
  // this branch those become opaque 500s: an integrator whose key simply lacks
  // a scope is told the server broke, and retries — which is both a bad
  // developer experience and load we invited.
  //
  // Matched structurally rather than with `instanceof`: this module is imported
  // by routes that never touch the API surface, and a hard import of the auth
  // module would drag the service-role client into all of them.
  if (isApiAuthErrorShape(error)) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: retryHeaders(error) }
    );
  }

  if (Object.prototype.hasOwnProperty.call(known, message)) {
    return NextResponse.json({ error: message }, { status: known[message] });
  }

  console.error(`[${context}]`, error);
  return NextResponse.json({ error: GENERIC_ERROR_MESSAGE }, { status: 500 });
}
