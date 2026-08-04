// The signed-in user's identity and authority, for client components.
//
// Exists because the browser has a Supabase session but no idea what the
// session may DO: the role lives in `company_members`, and the
// `custom_access_token_hook` that would have put it in the JWT was never
// enabled (see the RLS notes in CLAUDE.md), so there is nothing in the token to
// read. Rather than have every panel query the table itself — four round trips
// to render one workspace — the role is resolved once here and shared through
// `RoleProvider`.
//
// `capabilities` is sent resolved rather than as a role the client re-derives.
// The client already imports the same pure module, so either would work today;
// sending the resolved set means a future capability change takes effect on
// deploy instead of waiting for every cached bundle to be replaced.
//
// THIS IS A CONVENIENCE, NOT A CONTROL. Every capability it reports is checked
// again server-side on the request that uses it. Hiding a button the API would
// refuse is courtesy; the refusal is the security.

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { capabilitiesOf } from "@/lib/auth/roles";

export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json({
      userId: auth.userId,
      email: auth.email,
      companyId: auth.companyId,
      companyName: auth.companyName,
      role: auth.role,
      capabilities: capabilitiesOf(auth.role),
    });
  } catch (e) {
    return apiError(e, "me/GET");
  }
}
