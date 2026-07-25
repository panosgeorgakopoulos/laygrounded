import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { SECURITY_ACTIONS } from "@/lib/audit/security-log";
import { EVENT_COLUMNS, serializeEvent } from "@/lib/audit/query";

// The tenant's own audit trail, newest first.
//
// Read through the COOKIE client on purpose. security_events has a SELECT
// policy keyed on the JWT's company_id and no write policy at all, so RLS —
// not this handler — is what makes cross-tenant reads impossible. Using the
// service role here would move that guarantee into application code for no
// benefit. (The explicit companyId filter below is the usual defence in
// depth, not the primary control.)

const QuerySchema = z.object({
  action: z.enum(SECURITY_ACTIONS).optional(),
  outcome: z.enum(["allowed", "denied", "error"]).optional(),
  resourceId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Keyset pagination on the chain's own sequence — stable under concurrent
  // appends in a way that OFFSET is not.
  beforeSeq: z.coerce.number().int().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { action, outcome, resourceId, limit, beforeSeq } = parsed.data;

    const supabase = await createClient();
    let query = supabase
      .from("security_events")
      .select(EVENT_COLUMNS)
      .eq("company_id", auth.companyId)
      .order("seq", { ascending: false })
      .limit(limit);

    if (action) query = query.eq("action", action);
    if (outcome) query = query.eq("outcome", outcome);
    if (resourceId) query = query.eq("resource_id", resourceId);
    if (beforeSeq) query = query.lt("seq", beforeSeq);

    const { data, error } = await query;
    // A missing table means the migration has not been applied. Say so plainly
    // rather than returning an empty list, which would read as "nothing has
    // ever happened" — the most misleading possible answer from an audit log.
    if (error) {
      console.error("[security/events/GET] query failed", error);
      throw new Error("AUDIT_UNAVAILABLE");
    }

    const events = ((data ?? []) as unknown as Record<string, unknown>[]).map(serializeEvent);

    return NextResponse.json({
      events,
      // Present so a caller can page without re-deriving it from the last row.
      nextBeforeSeq: events.length === limit ? events[events.length - 1].seq : null,
    });
  } catch (e) {
    return apiError(e, "security/events/GET", { AUDIT_UNAVAILABLE: 503 });
  }
}
