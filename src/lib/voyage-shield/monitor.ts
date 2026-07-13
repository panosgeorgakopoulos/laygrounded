// In-voyage Legal Shield: monitors live voyages for weather stoppages the
// independent archive contradicts, and auto-drafts a Letter of Protest.
//
// Flow per sweep: re-run evidence verification on live (unsettled) claims →
// every contradicted weather check upserts a voyage_alert (the unique index
// on claim/type/event makes re-sweeps idempotent) → claims with *new* alerts
// get one grounded Letter of Protest from the agentic drafter, linked back to
// the alerts. Drafting failures leave the alert 'open' — the contradiction is
// still flagged for a human even when the LLM is unreachable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyClaimEvidence } from "@/lib/evidence/verify";
import { generateDraft } from "@/lib/drafting/drafter";

export interface VoyageShieldReport {
  scanned: number;
  contradictions: number;
  alertsCreated: number;
  draftsGenerated: number;
  reviewsQueued: number;
  errors: Array<{ claimId: string; error: string }>;
}

export interface VoyageShieldOptions {
  companyId?: string; // scope a manual run to one tenant
  claimId?: string; // single-claim run (ownership checked by the caller)
  limit?: number; // max claims per sweep (default 20)
}

const DEFAULT_SWEEP_LIMIT = 20;

export async function runVoyageShield(
  supabase: SupabaseClient,
  opts: VoyageShieldOptions = {}
): Promise<VoyageShieldReport> {
  const report: VoyageShieldReport = {
    scanned: 0,
    contradictions: 0,
    alertsCreated: 0,
    draftsGenerated: 0,
    reviewsQueued: 0,
    errors: [],
  };

  let claimIds: string[];
  if (opts.claimId) {
    claimIds = [opts.claimId];
  } else {
    // "Live" = not yet settled. The inner join narrows the sweep to claims
    // that actually assert a weather stoppage — everything else has nothing
    // for the archive to contradict.
    let query = supabase
      .from("claims")
      .select("id, updated_at, sof_events!inner(id)")
      .is("settled_at", null)
      .eq("sof_events.event_type", "WEATHER_DELAY")
      .neq("sof_events.status", "rejected")
      .order("updated_at", { ascending: false })
      .limit(opts.limit ?? DEFAULT_SWEEP_LIMIT);
    if (opts.companyId) query = query.eq("company_id", opts.companyId);

    const { data, error } = await query;
    if (error) throw new Error(`SWEEP_QUERY_FAILED: ${error.message}`);
    claimIds = (data ?? []).map((c) => c.id);
  }

  for (const claimId of claimIds) {
    report.scanned += 1;
    try {
      const checks = await verifyClaimEvidence(claimId, supabase);
      const contradicted = checks.filter(
        (c) => c.check_type === "weather" && c.verdict === "contradicted" && c.event_id
      );
      if (contradicted.length === 0) continue;
      report.contradictions += contradicted.length;

      // The verdict summary is copied into `detail` because evidence checks
      // are replace-on-rerun snapshots — the FK will null out on the next
      // verification, the copied facts must not.
      const { data: newAlerts, error: upsertErr } = await supabase
        .from("voyage_alerts")
        .upsert(
          contradicted.map((c) => ({
            claim_id: claimId,
            event_id: c.event_id,
            evidence_check_id: c.id,
            alert_type: "weather_contradicted",
            detail: { summary: c.summary, interval: c.data?.interval ?? null },
          })),
          { onConflict: "claim_id,alert_type,event_id", ignoreDuplicates: true }
        )
        .select("id");
      if (upsertErr) throw new Error(`ALERT_PERSIST_FAILED: ${upsertErr.message}`);

      const created = newAlerts ?? [];
      if (created.length === 0) continue; // already alerted on a prior sweep
      report.alertsCreated += created.length;

      // One protest per claim per sweep: the draft context carries every
      // evidence verdict, so a single letter covers all disputed windows.
      const draft = await generateDraft(claimId, "letter_of_protest", "firm", supabase);
      const { data: saved, error: draftErr } = await supabase
        .from("drafts")
        .insert({
          claim_id: claimId,
          kind: "letter_of_protest",
          tone: "firm",
          subject: draft.subject,
          content_md: draft.contentMd,
          position_analysis: draft.positionAnalysis,
          grounding: draft.grounding,
          model: draft.model,
        })
        .select("id")
        .single();
      if (draftErr || !saved) throw new Error(`DRAFT_PERSIST_FAILED: ${draftErr?.message}`);

      await supabase
        .from("voyage_alerts")
        .update({
          draft_id: saved.id,
          status: "draft_generated",
          updated_at: new Date().toISOString(),
        })
        .in(
          "id",
          created.map((a) => a.id)
        );
      report.draftsGenerated += 1;

      // HITL gate: the generated protest is queued for explicit human
      // approval — the Legal Shield drafts correspondence, it never serves
      // it. A 23505 means a review is already pending for this claim.
      const { error: reviewErr } = await supabase.from("pending_human_reviews").insert({
        claim_id: claimId,
        subject_type: "protest_draft",
        subject_id: saved.id,
        summary: draft.subject,
        payload: {
          alert_ids: created.map((a) => a.id),
          grounding_verified: draft.grounding.verified,
        },
        requested_by: "voyage-shield",
      });
      if (reviewErr && reviewErr.code !== "23505") {
        throw new Error(`REVIEW_PERSIST_FAILED: ${reviewErr.message}`);
      }
      if (!reviewErr) report.reviewsQueued += 1;
    } catch (e) {
      report.errors.push({
        claimId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}
