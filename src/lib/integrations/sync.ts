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
  IntegrationRow,
  NormalizedInvoice,
  NormalizedVoyage,
} from "./types";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const MAX_JOB_ATTEMPTS = 6;

export type SyncJobKind = "push_invoice" | "push_ledger" | "pull_voyages";

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
      await supabase
        .from("sync_jobs")
        .update({
          status: isDead ? "dead" : "pending",
          attempts,
          last_error: message.slice(0, 1000),
          next_attempt_at: new Date(Date.now() + computeBackoffMs(attempts)).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
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
    await supabase
      .from("integrations")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", integration.id);
    return;
  }

  // push_invoice / push_ledger need the claim's finalized numbers.
  const invoice = await buildInvoiceForClaim(supabase, job.claim_id);
  const result =
    job.kind === "push_invoice"
      ? await adapter.pushInvoice(invoice)
      : await adapter.pushLedger(invoice);

  // Outbound ledger entry — the audit trail mirror of inbound webhook_logs.
  await supabase.from("webhook_logs").insert({
    integration_id: integration.id,
    direction: "outbound",
    event_type: job.kind,
    idempotency_key: job.idempotency_key,
    payload: { invoice, result: { externalId: result.externalId } },
    status: "processed",
    processed_at: new Date().toISOString(),
  });
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
