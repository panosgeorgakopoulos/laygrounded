// The sync engine: an at-least-once outbound queue plus idempotent inbound
// voyage import.
//
// Concurrency model — no cross-instance coordination is assumed:
//   * Outbound jobs are claimed with an optimistic compare-and-set
//     (status pending → running); a job lost to another worker simply skips.
//   * Inbound webhooks dedupe on a unique (integration, direction, key) index;
//     the second delivery of the same event becomes `skipped_duplicate`.
//   * Imported claims upsert on (company_id, external_source, external_ref),
//     so concurrent voyage events for the same voyage cannot fork two claims.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdapter } from "./registry";
import { computeBackoffMs } from "./adapter";
import {
  AdapterCapabilities,
  IntegrationRow,
  IntegrationUnsupportedError,
  NormalizedInvoice,
  NormalizedSchedule,
  NormalizedVoyage,
  NormalizedVoyagePnl,
} from "./types";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { logStructured, newTraceId } from "@/lib/observability/log";

const MAX_JOB_ATTEMPTS = 6;

export type SyncJobKind =
  | "push_invoice"
  | "push_ledger"
  | "push_pnl"
  | "pull_voyages"
  | "pull_schedules";

/** Which adapter capability each job kind requires. */
const KIND_CAPABILITY: Record<SyncJobKind, keyof AdapterCapabilities> = {
  push_invoice: "pushInvoice",
  push_ledger: "pushLedger",
  push_pnl: "pushVoyagePnl",
  pull_voyages: "pullVoyages",
  pull_schedules: "pullSchedules",
};

// --- Outbound: enqueue ---

export async function enqueueSyncJob(
  supabase: SupabaseClient,
  integrationId: string,
  kind: SyncJobKind,
  opts: { claimId?: string; idempotencyKey: string; payload?: Record<string, unknown> }
): Promise<{ jobId: string | null; deduped: boolean }> {
  const { data, error } = await supabase
    .from("sync_jobs")
    .insert({
      integration_id: integrationId,
      claim_id: opts.claimId ?? null,
      kind,
      idempotency_key: opts.idempotencyKey,
      payload: opts.payload ?? {},
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique violation on the live-jobs index: same logical push is
    // already pending/running. That's the idempotency contract, not an error.
    if (error.code === "23505") return { jobId: null, deduped: true };
    throw new Error(`ENQUEUE_FAILED: ${error.message}`);
  }
  return { jobId: data?.id ?? null, deduped: false };
}

// --- Outbound: run ---

export interface SyncRunReport {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export async function runPendingSyncJobs(
  supabase: SupabaseClient,
  limit = 10
): Promise<SyncRunReport> {
  const report: SyncRunReport = { claimed: 0, succeeded: 0, failed: 0, dead: 0 };
  const traceId = newTraceId(); // one trace per sweep; job_id disambiguates within it

  const { data: candidates } = await supabase
    .from("sync_jobs")
    .select("id")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  for (const candidate of candidates ?? []) {
    // Optimistic claim: only one worker wins the pending → running transition.
    const { data: claimedRows } = await supabase
      .from("sync_jobs")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select("*");
    const job = claimedRows?.[0];
    if (!job) continue; // lost the race
    report.claimed++;

    try {
      await executeJob(supabase, job);
      await supabase
        .from("sync_jobs")
        .update({
          status: "succeeded",
          attempts: job.attempts + 1,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      report.succeeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const attempts = job.attempts + 1;
      const isDead = attempts >= MAX_JOB_ATTEMPTS;
      const nextAttemptAt = new Date(Date.now() + computeBackoffMs(attempts)).toISOString();
      await supabase
        .from("sync_jobs")
        .update({
          status: isDead ? "dead" : "pending",
          attempts,
          last_error: message.slice(0, 1000),
          next_attempt_at: nextAttemptAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      logStructured(isDead ? "error" : "warn", "erp-sync", `sync job failed: ${message}`, {
        trace_id: traceId,
        job_id: job.id,
        integration_id: job.integration_id,
        claim_id: job.claim_id ?? null,
        kind: job.kind,
        attempts,
        max_attempts: MAX_JOB_ATTEMPTS,
        user_action_required: isDead
          ? "Job is dead-lettered: inspect last_error on sync_jobs, fix the root cause (credentials/ERP availability/payload), then re-enqueue the push from the claim workspace."
          : null,
        retry_strategy: isDead
          ? "none — dead-lettered after max attempts"
          : `automatic jittered backoff; next attempt at ${nextAttemptAt}`,
      });
      if (isDead) report.dead++;
      else report.failed++;
    }
  }

  return report;
}

async function executeJob(supabase: SupabaseClient, job: any): Promise<void> {
  const { data: integration } = await supabase
    .from("integrations")
    .select("*")
    .eq("id", job.integration_id)
    .maybeSingle();
  if (!integration) throw new Error("INTEGRATION_NOT_FOUND");
  if (integration.status !== "active") throw new Error("INTEGRATION_NOT_ACTIVE");

  const adapter = getAdapter(integration as IntegrationRow);

  if (job.kind === "pull_voyages") {
    const voyages = await adapter.pullVoyages(integration.last_sync_at);
    for (const voyage of voyages) {
      await upsertVoyageClaim(supabase, integration as IntegrationRow, voyage);
    }
    await touchLastSync(supabase, integration.id);
    return;
  }

  if (job.kind === "pull_schedules") {
    const schedules = await adapter.pullSchedules(integration.last_sync_at);
    for (const schedule of schedules) {
      await upsertVesselSchedule(supabase, integration as IntegrationRow, schedule);
    }
    await touchLastSync(supabase, integration.id);
    return;
  }

  if (job.kind === "push_pnl") {
    const pnlId = String(job.payload?.voyage_pnl_id ?? "");
    if (!pnlId) throw new Error("MISSING_VOYAGE_PNL_ID");
    const pnl = await buildVoyagePnlForPush(supabase, pnlId);
    const result = await adapter.pushVoyagePnl(pnl);
    await recordOutbound(supabase, integration.id, job, {
      pnl,
      result: { externalId: result.externalId },
    });
    return;
  }

  // push_invoice / push_ledger need the claim's finalized numbers.
  const invoice = await buildInvoiceForClaim(supabase, job.claim_id);
  const result =
    job.kind === "push_invoice"
      ? await adapter.pushInvoice(invoice)
      : await adapter.pushLedger(invoice);

  await recordOutbound(supabase, integration.id, job, {
    invoice,
    result: { externalId: result.externalId },
  });
}

async function touchLastSync(supabase: SupabaseClient, integrationId: string): Promise<void> {
  await supabase
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", integrationId);
}

/** Outbound ledger entry — the audit trail mirror of inbound webhook_logs. */
async function recordOutbound(
  supabase: SupabaseClient,
  integrationId: string,
  job: { kind: string; idempotency_key: string },
  payload: Record<string, unknown>
): Promise<void> {
  await supabase.from("webhook_logs").insert({
    integration_id: integrationId,
    direction: "outbound",
    event_type: job.kind,
    idempotency_key: job.idempotency_key,
    payload,
    status: "processed",
    processed_at: new Date().toISOString(),
  });
}

/**
 * Whether an integration can perform a job kind, without running it.
 *
 * Callers use this to reject an impossible request with a 400 at the point the
 * user asks, instead of accepting it and dead-lettering six attempts later.
 */
export function supportsJobKind(integration: IntegrationRow, kind: SyncJobKind): boolean {
  return getAdapter(integration).capabilities[KIND_CAPABILITY[kind]];
}

export function assertSupportsJobKind(integration: IntegrationRow, kind: SyncJobKind): void {
  if (!supportsJobKind(integration, kind)) {
    throw new IntegrationUnsupportedError(
      `UNSUPPORTED_JOB_KIND: ${integration.provider} does not support '${kind}'`
    );
  }
}

// --- Invoice assembly (claim + latest calculation → normalized invoice) ---

export async function buildInvoiceForClaim(
  supabase: SupabaseClient,
  claimId: string
): Promise<NormalizedInvoice> {
  const { data: claim } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const { data: calc } = await supabase
    .from("laytime_calculations")
    .select("*")
    .eq("claim_id", claimId)
    .maybeSingle();
  if (!calc) throw new Error("NO_CALCULATION");

  const breakdown: any[] = Array.isArray(calc.breakdown) ? calc.breakdown : [];
  const kind = (calc.demurrage_amount ?? 0) > 0 ? "demurrage" : "despatch";

  return {
    externalRef: claim.external_ref ?? null,
    claimId: claim.id,
    vessel: claim.vessel,
    vesselImo: claim.vessel_imo ?? null,
    voyageRef: claim.voyage_ref,
    port: claim.port,
    kind,
    amount: kind === "demurrage" ? calc.demurrage_amount : calc.despatch_amount,
    currency: calc.currency,
    allowedHours: calc.allowed_hours,
    usedHours: calc.used_hours,
    computedAt: calc.computed_at,
    lines: breakdown.map((row) => ({
      description: row.reasoning,
      clauseRef: row.clause_ref,
      startTime: row.start_time,
      endTime: row.end_time,
      hours: row.duration_hours,
      counts: row.counts,
    })),
  };
}

// --- Voyage P&L assembly (stored sheet → normalized ERP payload) ---

/**
 * Builds the ERP payload for a voyage P&L.
 *
 * Recomputes rather than reading the last `voyage_pnl_results` snapshot: the
 * sheet's inputs (a linked claim's calculation) can move after a snapshot was
 * taken, and pushing a stale net result into an accounting system is the exact
 * failure this integration exists to prevent.
 */
export async function buildVoyagePnlForPush(
  supabase: SupabaseClient,
  pnlId: string
): Promise<NormalizedVoyagePnl> {
  // Imported lazily: `pnl-server.ts` pulls in the P&L calculator and its Zod
  // schemas, which the pull-only sync paths have no reason to load.
  const { computeStoredPnl } = await import("@/lib/pnl/pnl-server");
  const { pnl, claimIds, result } = await computeStoredPnl(pnlId, supabase);

  // `voyage_pnl` has no external ref of its own; the ERP matches on the voyage,
  // so the ref comes from a linked claim that was imported from that ERP.
  let externalRef: string | null = null;
  if (claimIds.length > 0) {
    const { data } = await supabase
      .from("claims")
      .select("external_ref")
      .in("id", claimIds)
      .not("external_ref", "is", null)
      .limit(1);
    externalRef = data?.[0]?.external_ref ?? null;
  }

  return {
    externalRef,
    voyagePnlId: pnlId,
    vessel: pnl.vessel,
    voyageRef: pnl.voyage_ref,
    charterType: pnl.charter_type,
    perspective: pnl.perspective,
    currency: result.currency,
    voyageStart: pnl.voyage_start,
    voyageEnd: pnl.voyage_end,
    grossRevenue: result.grossRevenue,
    revenueDeductions: result.revenueDeductions,
    voyageExpenses: result.voyageExpenses,
    transfers: result.transfers,
    netResult: result.netResult,
    tcePerDay: result.tcePerDay,
    voyageDays: result.voyageDays,
    computedAt: new Date().toISOString(),
    lines: result.lines.map((l) => ({
      key: l.key,
      label: l.label,
      kind: l.kind,
      // Signed exactly as the sheet computed it — see `NormalizedPnlLine`.
      amount: l.amount,
      currency: l.currency,
      excluded: l.excluded,
      note: l.note,
    })),
    // Never dropped: an incomplete sheet must arrive labelled incomplete.
    warnings: result.warnings,
  };
}

// --- Inbound: schedule → berth window (idempotent) ---

/**
 * Upserts a forward schedule row.
 *
 * Keyed on `(integration_id, external_ref)` so a re-pull updates in place
 * rather than accumulating one row per sweep. Unlike a voyage, a schedule is
 * NOT turned into a claim: an ETA is a plan, and manufacturing a claim from a
 * plan would put speculative port calls into the customer's book.
 */
export async function upsertVesselSchedule(
  supabase: SupabaseClient,
  integration: IntegrationRow,
  schedule: NormalizedSchedule
): Promise<void> {
  const { error } = await supabase.from("erp_vessel_schedules").upsert(
    {
      company_id: integration.company_id,
      integration_id: integration.id,
      external_ref: schedule.externalRef,
      vessel: schedule.vessel,
      vessel_imo: schedule.vesselImo ?? null,
      voyage_ref: schedule.voyageRef,
      port: schedule.port,
      port_function: schedule.portFunction,
      eta: schedule.etaISO,
      etb: schedule.etbISO,
      etd: schedule.etdISO,
      laycan_from: schedule.laycanFromISO,
      laycan_to: schedule.laycanToISO,
      cargo: schedule.cargo,
      cargo_quantity_mt: schedule.cargoQuantityMt,
      source_updated_at: schedule.updatedAt ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "integration_id,external_ref" }
  );
  if (error) throw new Error(`SCHEDULE_UPSERT_FAILED: ${error.message}`);
}

// --- Inbound: voyage → claim (idempotent) ---

export async function upsertVoyageClaim(
  supabase: SupabaseClient,
  integration: IntegrationRow,
  voyage: NormalizedVoyage
): Promise<string> {
  const { data, error } = await supabase
    .from("claims")
    .upsert(
      {
        company_id: integration.company_id,
        vessel: voyage.vessel,
        vessel_imo: voyage.vesselImo ?? null,
        voyage_ref: voyage.voyageRef,
        port: voyage.port,
        cargo: voyage.cargo,
        counterparty_name: voyage.counterpartyName ?? null,
        cp_form: "GENCON94",
        cp_terms: DEFAULT_CP_TERMS,
        status: "draft",
        external_source: integration.provider,
        external_ref: voyage.externalRef,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id,external_source,external_ref" }
    )
    .select("id")
    .single();

  if (error || !data) throw new Error(`VOYAGE_UPSERT_FAILED: ${error?.message}`);
  return data.id;
}
