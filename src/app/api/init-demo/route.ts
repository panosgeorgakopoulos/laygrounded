// POST /api/init-demo — pre-create the demo user + seed data, idempotent.
// Called by the sign-in page on mount to ensure demo credentials work.

import { NextResponse } from "next/server";
import { ensureDemoUser } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { seedScenarios } from "@/lib/seed-data";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

export async function POST() {
  if (process.env.SEED_DEMO !== "true") {
    return NextResponse.json({ ok: false, reason: "SEED_DEMO not enabled" });
  }
  const user = await ensureDemoUser();
  const membership = await db.companyMember.findFirst({
    where: { userId: user.id },
    include: { company: true },
  });
  if (!membership) {
    return NextResponse.json({ ok: false, reason: "no membership" });
  }
  const existingClaims = await db.claim.count({
    where: { companyId: membership.companyId },
  });
  if (existingClaims > 0) {
    return NextResponse.json({ ok: true, alreadySeeded: true, demoEmail: user.email });
  }
  for (const scenario of seedScenarios) {
    const claim = await db.claim.create({
      data: {
        companyId: membership.companyId,
        vessel: scenario.vessel,
        voyageRef: scenario.voyageRef,
        port: scenario.port,
        cargo: scenario.cargo,
        cpForm: "GENCON94",
        cpTerms: JSON.stringify(scenario.cpTerms),
        createdBy: user.id,
        status: "draft",
      },
    });
    const doc = await db.document.create({
      data: {
        claimId: claim.id,
        storagePath: `seed/${claim.id}`,
        originalFilename: `${scenario.vessel.replace(/[^a-zA-Z0-9]/g, "_")}-sof.pdf`,
        mime: "application/pdf",
        extractionStatus: "extracted",
        pageCount: 1,
      },
    });
    for (const ev of scenario.events) {
      await db.sofEvent.create({
        data: {
          claimId: claim.id,
          documentId: doc.id,
          occurredAt: new Date(ev.occurred_at),
          eventType: ev.event_type,
          rawText: ev.verbatim,
          page: ev.page,
          bbox: JSON.stringify(ev.bbox),
          confidence: ev.confidence,
          source: "ai",
          status: "accepted",
          aiReasoning: ev.reasoning,
        },
      });
    }
    try {
      await recomputeLaytimeServerFn(claim.id);
    } catch {
      // ignore
    }
  }
  return NextResponse.json({
    ok: true,
    seeded: seedScenarios.length,
    demoEmail: user.email,
  });
}
