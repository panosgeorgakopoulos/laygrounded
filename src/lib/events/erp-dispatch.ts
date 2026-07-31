// The first consumer of `domain_events`: fan an outbox event out to every ERP
// integration in the company that produced it.
//
// This is step 5 of the roadmap's migration sequence (the delivery worker)
// without extracting a process — the workload is I/O-bound and small, and the
// extraction criterion in the architecture doc requires two of four properties
// that this does not yet meet. It runs inside the app, driven by the same cron
// pattern as `/api/integrations/run-sync`.
//
// SHAPE OF THE PIPELINE. Two queues, deliberately:
//
//   state change ──trigger──▶ domain_events ──dispatch──▶ sync_jobs ──▶ ERP
//                  (same tx)                  (this file)   (delivery)
//
// `domain_events` records that something HAPPENED, atomically with the change.
// `sync_jobs` records that we intend to TELL someone, with its own backoff and
// dead-letter. Collapsing them would either put ERP delivery state inside the
// business transaction or lose the atomicity that makes the outbox worth
// having. An event is marked processed once its jobs are ENQUEUED, never once
// the ERP has accepted them — delivery is `sync_jobs`' responsibility from that
// point, and waiting here would rebuild a distributed transaction by hand.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DomainEvent,
  EVENT_TYPES,
  MAX_ATTEMPTS,
  markFailed,
  markProcessed,
  readUnprocessed,
} from "./outbox";
import { enqueueSyncJob, SyncJobKind } from "@/lib/integrations/sync";
import { getAdapter } from "@/lib/integrations/registry";
import type { AdapterCapabilities, IntegrationRow } from "@/lib/integrations/types";
import { logStructured, newTraceId } from "@/lib/observability/log";

/**
 * Claim statuses whose numbers are final enough to send to an accounting system.
 *
 * A recompute fires on every edit, including while an operator is still
 * assembling a draft. Pushing those would put a stream of contradictory
 * demurrage figures into the customer's ERP and destroy trust in the
 * integration faster than any outage. `demurrage` and `despatch` are the
 * engine's terminal verdicts; `completed` is the neutral one.
 */
const PUSHABLE_CLAIM_STATUSES = new Set(["completed", "demurrage", "despatch"]);

export interface DispatchReport {
  read: number;
  /** Events that produced at least one job. */
  dispatched: number;
  /** Events correctly requiring no ERP action (a draft, no integrations, …). */
  skipped: number;
  enqueued: number;
  deduped: number;
  failed: number;
  deadLettered: number;
}

interface PlannedJob {
  kind: SyncJobKind;
  claimId: string;
  capability: keyof AdapterCapabilities;
}

/**
 * Drains outstanding domain events into ERP sync jobs.
 *
 * Requires a service-role client: a worker has no session, and `integrations`
 * is RLS-protected. Tenancy therefore comes from `event.companyId` — the event
 * carries its own scope precisely because the client bypassing RLS cannot infer
 * one. Never widen this to read a company id from anywhere else.
 */
export async function dispatchErpEvents(
  db: SupabaseClient,
  { limit = 100 }: { limit?: number } = {}
): Promise<DispatchReport> {
  const report: DispatchReport = {
    read: 0,
    dispatched: 0,
    skipped: 0,
    enqueued: 0,
    deduped: 0,
    failed: 0,
    deadLettered: 0,
  };
  const traceId = newTraceId();

  const events = await readUnprocessed(db, { limit });
  report.read = events.length;

  for (const event of events) {
    // A poison event is left outstanding with its last_error rather than
    // retried forever: it would otherwise block nothing (the cursor skips it)
    // but would burn an attempt every sweep and hide fresher failures.
    if (event.attempts >= MAX_ATTEMPTS) {
      report.deadLettered++;
      continue;
    }

    try {
      const planned = await planJobs(db, event);
      if (planned.length === 0) {
        await markProcessed(db, event.id);
        report.skipped++;
        continue;
      }

      const integrations = await loadActiveIntegrations(db, event.companyId);
      if (integrations.length === 0) {
        // No ERP configured is a legitimate steady state, not a failure.
        await markProcessed(db, event.id);
        report.skipped++;
        continue;
      }

      let enqueuedForEvent = 0;
      for (const integration of integrations) {
        const capabilities = getAdapter(integration).capabilities;
        for (const job of planned) {
          // Declared capability, checked here rather than discovered on the
          // sixth retry. An ERP that cannot receive a P&L is a fact about the
          // product, not a transient failure.
          if (!capabilities[job.capability]) continue;

          const { deduped } = await enqueueSyncJob(db, integration.id, job.kind, {
            claimId: job.claimId,
            // Derived from the EVENT's idempotency key, so a redelivered event
            // cannot enqueue a second push of identical numbers.
            idempotencyKey: `evt:${event.idempotencyKey}:${job.kind}`,
            payload: { source_event_id: event.id, event_type: event.eventType },
          });
          if (deduped) report.deduped++;
          else {
            report.enqueued++;
            enqueuedForEvent++;
          }
        }
      }

      await markProcessed(db, event.id);
      if (enqueuedForEvent > 0) report.dispatched++;
      else report.skipped++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markFailed(db, event.id, e, event.attempts);
      report.failed++;
      logStructured("warn", "erp-dispatch", `event dispatch failed: ${message}`, {
        trace_id: traceId,
        event_id: event.id,
        event_type: event.eventType,
        company_id: event.companyId,
        attempts: event.attempts + 1,
        max_attempts: MAX_ATTEMPTS,
        retry_strategy:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "none — event will be left outstanding for inspection"
            : "automatic on the next dispatch sweep",
        user_action_required:
          event.attempts + 1 >= MAX_ATTEMPTS
            ? "Inspect domain_events.last_error for this id, fix the cause, then reset attempts to 0 to retry."
            : null,
      });
    }
  }

  return report;
}

/**
 * Decides what an event means for the ERP.
 *
 * Returns [] when the answer is "nothing", which is the common case and not an
 * error. The mapping is intentionally conservative: an event type absent from
 * this switch produces no ERP traffic at all, so adding an event type to the
 * outbox can never surprise a customer's accounting system.
 */
async function planJobs(db: SupabaseClient, event: DomainEvent): Promise<PlannedJob[]> {
  switch (event.eventType) {
    case EVENT_TYPES.CLAIM_RECOMPUTED: {
      const claimId = String((event.payload as { claim_id?: string }).claim_id ?? "");
      if (!claimId) return [];
      if (!(await claimIsPushable(db, claimId, event.companyId))) return [];
      return [
        { kind: "push_invoice", claimId, capability: "pushInvoice" },
        { kind: "push_ledger", claimId, capability: "pushLedger" },
      ];
    }

    case EVENT_TYPES.SETTLEMENT_CHANGED: {
      const payload = event.payload as { claim_id?: string; status?: string };
      const claimId = String(payload.claim_id ?? "");
      // Only a cleared settlement is news for an accounting system; the
      // intermediate states are our own workflow, not theirs.
      if (!claimId || payload.status !== "cleared") return [];
      if (!(await claimIsPushable(db, claimId, event.companyId))) return [];
      return [{ kind: "push_invoice", claimId, capability: "pushInvoice" }];
    }

    // `risk.assessed` is deliberately absent. A Monte Carlo exposure is a
    // PREDICTION, and an ERP books facts. Pushing a probability into a voyage
    // ledger would let a forecast be read later as an incurred cost.
    default:
      return [];
  }
}

/**
 * True when the claim exists, belongs to the event's company, and is final.
 *
 * The company check is not redundant with the event's `company_id`: this client
 * is service-role, so nothing else would stop a malformed payload naming
 * another tenant's claim from being pushed to THIS tenant's ERP.
 */
async function claimIsPushable(
  db: SupabaseClient,
  claimId: string,
  companyId: string
): Promise<boolean> {
  const { data } = await db
    .from("claims")
    .select("id, status, company_id")
    .eq("id", claimId)
    .maybeSingle();

  // Events outlive their aggregates: a deleted claim is a no-op, not an error.
  if (!data) return false;
  if (data.company_id !== companyId) return false;
  return PUSHABLE_CLAIM_STATUSES.has(data.status);
}

async function loadActiveIntegrations(
  db: SupabaseClient,
  companyId: string
): Promise<IntegrationRow[]> {
  const { data, error } = await db
    .from("integrations")
    .select(
      "id, company_id, provider, display_name, base_url, auth, config, status, last_error, last_sync_at"
    )
    .eq("company_id", companyId)
    .eq("status", "active");

  if (error) throw new Error(`INTEGRATIONS_READ_FAILED: ${error.message}`);
  return (data ?? []) as unknown as IntegrationRow[];
}
