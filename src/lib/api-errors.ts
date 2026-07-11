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
};

export const GENERIC_ERROR_MESSAGE = "An unexpected server error occurred";

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

  if (Object.prototype.hasOwnProperty.call(known, message)) {
    return NextResponse.json({ error: message }, { status: known[message] });
  }

  console.error(`[${context}]`, error);
  return NextResponse.json({ error: GENERIC_ERROR_MESSAGE }, { status: 500 });
}
