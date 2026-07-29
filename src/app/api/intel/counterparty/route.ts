import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadCounterpartyProfile, listCounterparties } from "@/lib/intel/counterparty-server";
import { apiError } from "@/lib/api-errors";

// Counterparty risk profile, computed on demand from the caller's own book.
//
// Tenancy comes from the session, never the query string: `auth.companyId` is
// the only company id that reaches the loader, so no `?company=` parameter can
// widen the read. Nothing is persisted — the profile is a view over live claims,
// which is also what makes the correction path real (fix the claim, the profile
// changes on the next read).
//
//   GET /api/intel/counterparty            → counterparties in your book
//   GET /api/intel/counterparty?name=<x>   → the profile for one of them
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const name = req.nextUrl.searchParams.get("name");

    if (!name) {
      const counterparties = await listCounterparties(auth.companyId, supabase);
      return NextResponse.json({ counterparties });
    }

    const profile = await loadCounterpartyProfile(auth.companyId, name, supabase);
    return NextResponse.json({ profile });
  } catch (e) {
    return apiError(e, "intel/counterparty/GET");
  }
}
