// POST /api/claims/[claimId]/flag-clauses — run clause flagging on accepted events.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { flagClauses } from "@/lib/clause-flagging";
import { CpTerms } from "@/lib/laytime/types";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const cpTerms: CpTerms | null = claim.cpTerms
      ? JSON.parse(claim.cpTerms)
      : null;
    if (!cpTerms) {
      return NextResponse.json({ error: "NO_CP_TERMS" }, { status: 400 });
    }
    const flags = await flagClauses(claimId, cpTerms);
    return NextResponse.json({
      flags: flags.map((f) => ({
        id: f.id,
        eventId: f.eventId,
        clauseRef: f.clauseRef,
        severity: f.severity,
        note: f.note,
        createdAt: f.createdAt,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
