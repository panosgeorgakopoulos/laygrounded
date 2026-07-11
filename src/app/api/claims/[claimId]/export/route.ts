// POST /api/claims/[claimId]/export — generate PDF + XLSX claim pack.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { exportClaimPack } from "@/lib/export";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const result = await exportClaimPack({
      claimId,
      companyId: auth.companyId,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[export] failed:", e);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
