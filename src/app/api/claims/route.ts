// GET /api/claims — list claims for current user's company.
// POST /api/claims — create new claim.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const CreateClaimSchema = z.object({
  vessel: z.string().min(1),
  voyageRef: z.string().min(1),
  port: z.string().min(1),
  cargo: z.string().min(1),
  cpForm: z.string().default("GENCON94"),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const claims = await db.claim.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { sofEvents: true, documents: true } } },
    });
    const withExposure = await Promise.all(
      claims.map(async (c) => {
        const calc = await db.laytimeCalculation.findFirst({
          where: { claimId: c.id },
          orderBy: { computedAt: "desc" },
        });
        return {
          id: c.id,
          vessel: c.vessel,
          voyageRef: c.voyageRef,
          port: c.port,
          cargo: c.cargo,
          status: c.status,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          eventCount: c._count.sofEvents,
          documentCount: c._count.documents,
          exposure: calc
            ? {
                demurrageAmount: calc.demurrageAmount,
                despatchAmount: calc.despatchAmount,
                currency: calc.currency,
                usedHours: calc.usedHours,
                allowedHours: calc.allowedHours,
              }
            : null,
        };
      })
    );
    return NextResponse.json({ claims: withExposure });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const body = await req.json();
    const parsed = CreateClaimSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const claim = await db.claim.create({
      data: {
        companyId: auth.companyId,
        vessel: parsed.data.vessel,
        voyageRef: parsed.data.voyageRef,
        port: parsed.data.port,
        cargo: parsed.data.cargo,
        cpForm: parsed.data.cpForm,
        cpTerms: JSON.stringify(DEFAULT_CP_TERMS),
        createdBy: auth.userId,
        status: "draft",
      },
    });
    return NextResponse.json({ claim });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
