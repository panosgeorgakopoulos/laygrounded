// The settlement consumer: `claim.settlement_ready` → a stored settlement payload.
//
// The THIRD consumer of `domain_events`, and the one that most justifies the
// per-consumer model: generating a payment instruction must not be coupled to
// whether an ERP push or a logistics webhook succeeded.
//
// It generates and stores; it does NOT move money. A downstream processor (a
// bank adapter, or an escrow contract) reads `settlement_payloads` and decides.
// Keeping generation separate from execution is what allows the payload to be
// reviewed, and it is why `ready: false` is a perfectly normal outcome here
// rather than an error.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONSUMERS,
  EVENT_TYPES,
  MAX_ATTEMPTS,
  markFailedBy,
  markProcessedBy,
  readUnprocessedFor,
} from "./outbox";
import { buildSettlementForClaim, persistSettlementPayload } from "@/lib/settlement/escrow-server";
import { logStructured, newTraceId } from "@/lib/observability/log";

export interface SettlementDispatchReport {
  read: number;
  generated: number;
  /** Payloads stored but not actionable (blockers present). */
  notReady: number;
  /** Already generated for this calculation. */
  deduped: number;
  skipped: number;
  failed: number;
  deadLettered: number;
}

export async function dispatchSettlementPayloads(
  db: SupabaseClient,
  { limit = 100, now = new Date() }: { limit?: number; now?: Date } = {}
): Promise<SettlementDispatchReport> {
  const report: SettlementDispatchReport = {
    read: 0,
    generated: 0,
    notReady: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
  };
  const traceId = newTraceId();

  const events = await readUnprocessedFor(db, CONSUMERS.SETTLEMENT, { limit });
  report.read = events.length;

  for (const event of events) {
    if (event.attempts >= MAX_ATTEMPTS) {
      report.deadLettered++;
      continue;
    }

    // Only agreement produces a settlement. Every other event type — including
    // `claim.recomputed`, which fires constantly — is correctly ignored.
    if (event.eventType !== EVENT_TYPES.SETTLEMENT_READY) {
      await markProcessedBy(db, event.id, CONSUMERS.SETTLEMENT);
      report.skipped++;
      continue;
    }

    const claimId = String((event.payload as { claim_id?: string }).claim_id ?? "");
    if (!claimId) {
      await markProcessedBy(db, event.id, CONSUMERS.SETTLEMENT);
      report.skipped++;
      continue;
    }

    try {
      const loaded = await buildSettlementForClaim(db, claimId, now.toISOString());

      // The worker is service-role, so the event's own company is the only
      // tenancy check standing between one tenant's claim and another's
      // settlement instruction.
      if (loaded.companyId !== event.companyId) {
        await markProcessedBy(db, event.id, CONSUMERS.SETTLEMENT);
        report.skipped++;
        continue;
      }

      const { persisted } = await persistSettlementPayload(db, loaded);
      if (!persisted) report.deduped++;
      else if (loaded.payload.ready) report.generated++;
      else report.notReady++;

      if (!loaded.payload.ready) {
        // Not an error: a payload with blockers is a correct answer that says
        // why it cannot be acted on. Logged at info so it is visible without
        // paging anyone.
        logStructured("info", "settlement-dispatch", "settlement payload not actionable", {
          trace_id: traceId,
          claim_id: claimId,
          settlement_ref: loaded.payload.settlementRef,
          blockers: loaded.payload.blockers,
          user_action_required:
            "Resolve the listed blockers, then re-agree the claim to regenerate the payload.",
        });
      }

      await markProcessedBy(db, event.id, CONSUMERS.SETTLEMENT);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      // A claim or calculation that has since been deleted is a no-op, not a
      // failure — events outlive their aggregates.
      if (message === "CLAIM_NOT_FOUND" || message === "NO_CALCULATION") {
        await markProcessedBy(db, event.id, CONSUMERS.SETTLEMENT);
        report.skipped++;
        continue;
      }

      await markFailedBy(db, event.id, CONSUMERS.SETTLEMENT, e, event.attempts);
      report.failed++;
      logStructured("warn", "settlement-dispatch", `settlement generation failed: ${message}`, {
        trace_id: traceId,
        event_id: event.id,
        claim_id: claimId,
        company_id: event.companyId,
        attempts: event.attempts + 1,
        max_attempts: MAX_ATTEMPTS,
        retry_strategy:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "none — left outstanding for inspection"
            : "automatic on the next dispatch sweep",
        user_action_required:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "Inspect domain_event_consumptions.last_error for consumer 'settlement'."
            : null,
      });
    }
  }

  return report;
}
