// The hinterland consumer: domain events → queued webhook notifications.
//
// The SECOND consumer of `domain_events`, and the reason
// `domain_event_consumptions` exists. Before that table, processing state was a
// single `processed_at` flag, so whichever sweep ran first would mark an event
// handled and the other would never see it — ERP pushes would have stopped
// silently the day this shipped.
//
// Same two-queue shape as the ERP dispatcher:
//
//   state change ─trigger─▶ domain_events ─dispatch─▶ api_webhook_deliveries ─▶ partner
//                 (same tx)              (this file)      (retrying sweep)
//
// An event is marked processed once its deliveries are ENQUEUED. Delivery,
// retry and dead-lettering belong to `runPendingDeliveries`.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONSUMERS,
  DomainEvent,
  EVENT_TYPES,
  MAX_ATTEMPTS,
  markFailedBy,
  markProcessedBy,
  readUnprocessedFor,
} from "./outbox";
import {
  enqueueDelivery,
  SUBSCRIPTION_COLUMNS,
  type WebhookSubscription,
} from "@/lib/webhooks/delivery";
import {
  buildDelayPayload,
  buildStoppagePayload,
  decideDelayNotification,
  decideStoppageNotification,
  thresholdFor,
  type RiskSnapshot,
  type StoppageSnapshot,
} from "@/lib/webhooks/hinterland";
import { logStructured, newTraceId } from "@/lib/observability/log";

export interface WebhookDispatchReport {
  read: number;
  /** Events that queued at least one notification. */
  dispatched: number;
  /** Events correctly requiring no notification (below threshold, no subs, …). */
  skipped: number;
  enqueued: number;
  deduped: number;
  failed: number;
  deadLettered: number;
}

export async function dispatchHinterlandWebhooks(
  db: SupabaseClient,
  { limit = 100, now = new Date() }: { limit?: number; now?: Date } = {}
): Promise<WebhookDispatchReport> {
  const report: WebhookDispatchReport = {
    read: 0,
    dispatched: 0,
    skipped: 0,
    enqueued: 0,
    deduped: 0,
    failed: 0,
    deadLettered: 0,
  };
  const traceId = newTraceId();

  const events = await readUnprocessedFor(db, CONSUMERS.HINTERLAND, { limit });
  report.read = events.length;

  for (const event of events) {
    if (event.attempts >= MAX_ATTEMPTS) {
      report.deadLettered++;
      continue;
    }

    try {
      const subscriptions = await loadSubscriptions(db, event.companyId);
      if (subscriptions.length === 0) {
        await markProcessedBy(db, event.id, CONSUMERS.HINTERLAND);
        report.skipped++;
        continue;
      }

      let enqueuedForEvent = 0;
      for (const subscription of subscriptions) {
        const threshold = thresholdFor(subscription.config);
        const planned = await planNotification(db, event, threshold, now);
        if (!planned) continue;
        // A partner only receives event types they subscribed to.
        if (!subscription.event_types.includes(planned.eventType)) continue;

        const { deduped } = await enqueueDelivery(db, subscription, {
          eventType: planned.eventType,
          claimId: planned.claimId,
          payload: planned.payload,
          // Derived from the EVENT's key, so a redelivered event cannot page a
          // partner twice for the same underlying fact. The threshold is in the
          // key because two subscriptions with different thresholds are
          // genuinely different decisions about the same event.
          idempotencyKey: `evt:${event.idempotencyKey}:${planned.eventType}:${threshold}`,
        });

        if (deduped) report.deduped++;
        else {
          report.enqueued++;
          enqueuedForEvent++;
        }
      }

      await markProcessedBy(db, event.id, CONSUMERS.HINTERLAND);
      if (enqueuedForEvent > 0) report.dispatched++;
      else report.skipped++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markFailedBy(db, event.id, CONSUMERS.HINTERLAND, e, event.attempts);
      report.failed++;
      logStructured("warn", "webhook-dispatch", `hinterland dispatch failed: ${message}`, {
        trace_id: traceId,
        event_id: event.id,
        event_type: event.eventType,
        company_id: event.companyId,
        attempts: event.attempts + 1,
        max_attempts: MAX_ATTEMPTS,
        retry_strategy:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "none — left outstanding for inspection"
            : "automatic on the next dispatch sweep",
        user_action_required:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "Inspect domain_event_consumptions.last_error for consumer 'hinterland', fix the cause, then reset attempts to 0."
            : null,
      });
    }
  }

  return report;
}

interface PlannedNotification {
  eventType: string;
  claimId: string | null;
  payload: unknown;
}

/**
 * Turns an event into a notification, or nothing.
 *
 * Reads the aggregate rather than trusting the payload: the outbox payload is a
 * pointer plus a digest by design, and the statistics this decision needs
 * (`p90_waiting_hours`) are not in it.
 */
async function planNotification(
  db: SupabaseClient,
  event: DomainEvent,
  thresholdHours: number,
  now: Date
): Promise<PlannedNotification | null> {
  if (event.eventType === EVENT_TYPES.RISK_ASSESSED) {
    const riskId = String((event.payload as { risk_id?: string }).risk_id ?? "");
    if (!riskId) return null;

    const { data } = await db
      .from("pre_arrival_risks")
      .select(
        "id, company_id, claim_id, vessel, voyage_ref, port, cargo, eta, decision_grade, p90_waiting_hours, p90_stoppage_hours, demurrage_probability, p90_exposure, currency"
      )
      .eq("id", riskId)
      .maybeSingle();

    // Events outlive their aggregates; a deleted assessment is a no-op.
    if (!data) return null;
    // Service-role read: the tenant check is ours to make, not RLS's.
    if (data.company_id !== event.companyId) return null;

    const snapshot: RiskSnapshot = {
      riskId: data.id,
      claimId: data.claim_id,
      vessel: data.vessel,
      voyageRef: data.voyage_ref,
      port: data.port,
      cargo: data.cargo,
      etaISO: data.eta,
      decisionGrade: data.decision_grade,
      p90WaitingHours: data.p90_waiting_hours,
      p90StoppageHours: data.p90_stoppage_hours,
      demurrageProbability: data.demurrage_probability,
      p90Exposure: data.p90_exposure,
      currency: data.currency,
    };

    const decision = decideDelayNotification(snapshot, thresholdHours);
    if (!decision.fire) return null;

    return {
      eventType: decision.event,
      claimId: snapshot.claimId,
      payload: buildDelayPayload(snapshot, decision.delayHours, thresholdHours, now),
    };
  }

  if (event.eventType === EVENT_TYPES.CLAIM_RECOMPUTED) {
    const claimId = String((event.payload as { claim_id?: string }).claim_id ?? "");
    if (!claimId) return null;

    const snapshot = await loadStoppageSnapshot(db, claimId, event.companyId);
    if (!snapshot) return null;

    const decision = decideStoppageNotification(snapshot, thresholdHours);
    if (!decision.fire) return null;

    return {
      eventType: decision.event,
      claimId,
      payload: buildStoppagePayload(snapshot, thresholdHours, now),
    };
  }

  // Every other event type produces no hinterland traffic. Adding an event type
  // to the outbox must never surprise a logistics partner.
  return null;
}

/**
 * Total agreed stoppage hours on a claim's current calculation.
 *
 * Read from the engine's own breakdown rather than from raw SoF events: an
 * `EXCEPTED_PERIOD_START` in the timeline is a *claim* about an interruption,
 * whereas a non-counting breakdown row is the engine's *verdict* on it under
 * the charterparty. Only the second one has moved money, and only the second
 * one is worth re-planning a train around.
 */
async function loadStoppageSnapshot(
  db: SupabaseClient,
  claimId: string,
  companyId: string
): Promise<StoppageSnapshot | null> {
  const { data: claim } = await db
    .from("claims")
    .select("id, company_id, vessel, voyage_ref, port, cargo, status")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim || claim.company_id !== companyId) return null;

  const { data: calc } = await db
    .from("laytime_calculations")
    .select("breakdown, demurrage_amount, currency, computed_at")
    .eq("claim_id", claimId)
    .maybeSingle();
  if (!calc) return null;

  const breakdown = Array.isArray(calc.breakdown) ? calc.breakdown : [];
  let stoppageHours = 0;
  let lastEnd: string | null = null;

  for (const row of breakdown as Array<Record<string, unknown>>) {
    const hours = Number(row.duration_hours);
    if (row.counts === false && Number.isFinite(hours) && hours > 0) {
      stoppageHours += hours;
    }
    const end = typeof row.end_time === "string" ? row.end_time : null;
    if (end && (!lastEnd || end > lastEnd)) lastEnd = end;
  }

  return {
    claimId,
    vessel: claim.vessel,
    voyageRef: claim.voyage_ref,
    port: claim.port,
    cargo: claim.cargo,
    stoppageHours,
    revisedCompletionISO: lastEnd,
    currency: calc.currency,
    demurrageAmount: calc.demurrage_amount,
  };
}

async function loadSubscriptions(
  db: SupabaseClient,
  companyId: string
): Promise<WebhookSubscription[]> {
  const { data, error } = await db
    .from("api_webhooks")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("company_id", companyId)
    .eq("status", "active");

  if (error) throw new Error(`SUBSCRIPTIONS_READ_FAILED: ${error.message}`);
  return (data ?? []) as unknown as WebhookSubscription[];
}
