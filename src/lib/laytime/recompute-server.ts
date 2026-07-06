// Server-side laytime recompute helper.
// Wraps the pure recomputeLaytime engine, fetches accepted events, upserts laytime_calculations.

import { db } from "@/lib/db";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, LaytimeResult, SofEventInput } from "@/lib/laytime/types";

export async function recomputeLaytimeServerFn(
  claimId: string
): Promise<LaytimeResult> {
  const claim = await db.claim.findUnique({ where: { id: claimId } });
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const cpTerms: CpTerms | null = claim.cpTerms
    ? JSON.parse(claim.cpTerms)
    : null;
  if (!cpTerms) throw new Error("NO_CP_TERMS");

  const events = await db.sofEvent.findMany({
    where: { claimId, status: { in: ["accepted", "edited"] } },
    orderBy: { occurredAt: "asc" },
  });

  const sofInputs: SofEventInput[] = events.map((e) => ({
    id: e.id,
    occurred_at: e.occurredAt.toISOString(),
    event_type: e.eventType as any,
  }));

  const result = recomputeLaytime(sofInputs, cpTerms);

  // Upsert laytime_calculations (delete previous, insert new).
  await db.laytimeCalculation.deleteMany({ where: { claimId } });
  await db.laytimeCalculation.create({
    data: {
      claimId,
      inputs: JSON.stringify({ cpTerms, events: sofInputs }),
      breakdown: JSON.stringify(result.breakdown),
      usedHours: result.totals.used_hours,
      allowedHours: result.totals.allowed_hours,
      demurrageAmount: result.totals.demurrage_amount,
      despatchAmount: result.totals.despatch_amount,
      currency: result.totals.currency,
    },
  });

  // Update claim status based on result.
  let newStatus = claim.status;
  if (result.totals.demurrage_amount > 0) newStatus = "demurrage";
  else if (result.totals.despatch_amount > 0) newStatus = "despatch";
  else if (events.length > 0) newStatus = "in_progress";
  if (newStatus !== claim.status) {
    await db.claim.update({
      where: { id: claimId },
      data: { status: newStatus, updatedAt: new Date() },
    });
  }

  return result;
}
