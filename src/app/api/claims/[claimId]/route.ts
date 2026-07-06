// GET /api/claims/[claimId] — fetch full claim with all relations.
// PATCH /api/claims/[claimId] — update claim (CP terms, status, etc.)

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { CpTerms } from "@/lib/laytime/types";

const UpdateClaimSchema = z.object({
  vessel: z.string().min(1).optional(),
  voyageRef: z.string().min(1).optional(),
  port: z.string().min(1).optional(),
  cargo: z.string().min(1).optional(),
  cpTerms: z.any().optional(),
  status: z.string().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const claim = await db.claim.findUnique({
      where: { id: claimId },
      include: {
        documents: { orderBy: { createdAt: "desc" } },
        sofEvents: { orderBy: { occurredAt: "asc" } },
        calculations: { orderBy: { computedAt: "desc" }, take: 1 },
        company: true,
      },
    });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    // Fetch clause flags via events.
    const eventIds = claim.sofEvents.map((e) => e.id);
    const clauseFlags = await db.clauseFlag.findMany({
      where: { eventId: { in: eventIds } },
    });
    return NextResponse.json({ claim, clauseFlags });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const body = await req.json();
    const parsed = UpdateClaimSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const data: any = { updatedAt: new Date() };
    if (parsed.data.vessel) data.vessel = parsed.data.vessel;
    if (parsed.data.voyageRef) data.voyageRef = parsed.data.voyageRef;
    if (parsed.data.port) data.port = parsed.data.port;
    if (parsed.data.cargo) data.cargo = parsed.data.cargo;
    if (parsed.data.status) data.status = parsed.data.status;
    if (parsed.data.cpTerms) data.cpTerms = JSON.stringify(parsed.data.cpTerms);
    const updated = await db.claim.update({ where: { id: claimId }, data });
    return NextResponse.json({ claim: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
