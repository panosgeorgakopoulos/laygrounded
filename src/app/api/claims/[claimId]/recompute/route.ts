// POST /api/claims/[claimId]/recompute — re-run laytime engine on accepted events.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const { db } = await import("@/lib/db");
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const result = await recomputeLaytimeServerFn(claimId);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: e instanceof Error && e.message === "NO_NOR" ? 400 : 500 }
    );
  }
}
