import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { flagClauses } from "@/lib/clause-flagging";
import { CpTerms } from "@/lib/laytime/types";
import { createServiceRoleClient } from "@/lib/supabase/server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id, cp_terms")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const cpTerms: CpTerms | null = claim.cp_terms as any;
    if (!cpTerms) {
      return NextResponse.json({ error: "NO_CP_TERMS" }, { status: 400 });
    }
    const flags = await flagClauses(claimId, cpTerms);
    return NextResponse.json({
      flags: flags.map((f: any) => ({
        id: f.id,
        eventId: f.event_id,
        clauseRef: f.clause_ref,
        severity: f.severity,
        note: f.note,
        createdAt: f.created_at,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
