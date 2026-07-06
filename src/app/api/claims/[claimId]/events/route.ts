// GET /api/claims/[claimId]/events — list all SoF events.
// POST /api/claims/[claimId]/events — add event manually (source=user, status=accepted).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { EVENT_TYPE_VALUES, EventTypeEnum } from "@/lib/laytime/types";

const CreateEventSchema = z.object({
  occurredAt: z.string(),
  eventType: z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]),
  rawText: z.string().default(""),
  page: z.number().int().default(1),
});

export async function GET(
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
    const events = await db.sofEvent.findMany({
      where: { claimId },
      orderBy: { occurredAt: "asc" },
      include: { clauseFlags: true },
    });
    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(
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
    const parsed = CreateEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Need a documentId — find first document for this claim, or create a placeholder.
    let doc = await db.document.findFirst({ where: { claimId } });
    if (!doc) {
      doc = await db.document.create({
        data: {
          claimId,
          storagePath: `manual/${claimId}`,
          originalFilename: "manual-entry",
          mime: "manual",
          extractionStatus: "extracted",
        },
      });
    }

    const event = await db.sofEvent.create({
      data: {
        claimId,
        documentId: doc.id,
        occurredAt: new Date(parsed.data.occurredAt),
        eventType: parsed.data.eventType,
        rawText: parsed.data.rawText,
        page: parsed.data.page,
        bbox: JSON.stringify({ x: 0, y: 0, width: 0, height: 0 }),
        confidence: 1.0,
        source: "user",
        status: "accepted",
      },
    });

    // Trigger recompute.
    let calc;
    try {
      calc = await recomputeLaytimeServerFn(claimId);
    } catch (e) {
      // ignore — no NOR yet
    }

    return NextResponse.json({ event, calc });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
