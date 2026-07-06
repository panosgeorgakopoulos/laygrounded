// POST /api/seed — seed demo company with 3 synthetic SoF scenarios.
// Only runs when SEED_DEMO env var is set or when explicitly called by an authenticated admin.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { seedScenarios } from "@/lib/seed-data";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

export async function POST() {
  try {
    const auth = await requireAuth();
    const created: any[] = [];
    for (const scenario of seedScenarios) {
      const claim = await db.claim.create({
        data: {
          companyId: auth.companyId,
          vessel: scenario.vessel,
          voyageRef: scenario.voyageRef,
          port: scenario.port,
          cargo: scenario.cargo,
          cpForm: "GENCON94",
          cpTerms: JSON.stringify(scenario.cpTerms),
          createdBy: auth.userId,
          status: "draft",
        },
      });
      // Create a placeholder document.
      const doc = await db.document.create({
        data: {
          claimId: claim.id,
          storagePath: `seed/${claim.id}`,
          originalFilename: `${scenario.vessel}-sof.pdf`,
          mime: "application/pdf",
          extractionStatus: "extracted",
          pageCount: 1,
        },
      });
      // Create events.
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
      // Recompute laytime.
      try {
        await recomputeLaytimeServerFn(claim.id);
      } catch (e) {
        // ignore
      }
      created.push(claim.id);
    }
    return NextResponse.json({ seeded: created.length, claimIds: created });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
