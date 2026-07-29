// Sweep for protective notices and SoF chase requests.
//
// Both features are "the automation noticed something and drafted a letter", so
// both follow the pattern the Legal Shield established and share one worker:
// draft → store → queue for human approval. **Nothing is ever served from a
// sweep.** The HITL row is the gate and the audit record; the drafts table
// holds exactly what a human will be asked to approve.
//
// Idempotency has two layers, because the two features fail differently:
//   * protective notice — at most one per claim, ever. The guard is "does a
//     protective_notice draft already exist", so it holds even after a review
//     has been approved or rejected and the partial unique index no longer
//     applies.
//   * SoF chase — one per *gap set*. Chasing again when the agent has supplied
//     nothing is spam; chasing again when a different milestone has gone
//     missing is the job. The gap signature is stored on the review payload and
//     compared on the next pass.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeTimeBar } from "@/lib/time-bar";
import { detectSofGaps, type SofGapReport } from "@/lib/ingestion/sof-gaps";
import {
  evaluateProtectiveNotice,
  type ProtectiveNoticeDecision,
} from "@/lib/voyage/protective-notice";
import { generateDraft, type DraftKind } from "@/lib/drafting/drafter";

export interface NoticeSweepReport {
  scanned: number;
  noticesDue: number;
  noticesDrafted: number;
  chasesDue: number;
  chasesDrafted: number;
  skipped: number;
  errors: Array<{ claimId: string; error: string }>;
}

export interface NoticeSweepOptions {
  companyId?: string;
  claimId?: string;
  limit?: number;
  /** Days before the time bar at which a protective notice becomes due. */
  leadDays?: number;
  /** Hours of silence before an absent milestone counts as missing. */
  staleAfterHours?: number;
  /**
   * Compute what is due and report it without drafting or writing anything.
   * The sweep calls an LLM per claim, so a dry run is how an operator inspects
   * a sweep's intentions before paying for them.
   */
  dryRun?: boolean;
}

const DEFAULT_SWEEP_LIMIT = 25;
const CONFIRMED = ["accepted", "edited"];

interface ClaimFacts {
  id: string;
  settled: boolean;
  notice: ProtectiveNoticeDecision;
  gaps: SofGapReport;
  hasNoticeDraft: boolean;
  lastChaseSignature: string | null;
}

/**
 * Everything both decisions need, for one claim. Kept separate from the acting
 * half so the sweep's judgement can be inspected (and dry-run) without any
 * drafting having happened.
 */
async function gatherFacts(
  claimId: string,
  supabase: SupabaseClient,
  now: Date,
  opts: NoticeSweepOptions
): Promise<ClaimFacts> {
  const { data: claim } = await supabase
    .from("claims")
    .select("id, time_bar_days, settled_at, cp_terms")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const [{ data: events }, { count: docCount }, { data: calc }, { data: drafts }, { data: reviews }] =
    await Promise.all([
      supabase
        .from("sof_events")
        .select("event_type, occurred_at")
        .eq("claim_id", claimId)
        .in("status", CONFIRMED),
      supabase.from("documents").select("id", { count: "exact", head: true }).eq("claim_id", claimId),
      supabase.from("laytime_calculations").select("id").eq("claim_id", claimId).maybeSingle(),
      supabase.from("drafts").select("kind").eq("claim_id", claimId).eq("kind", "protective_notice"),
      supabase
        .from("pending_human_reviews")
        .select("payload, created_at")
        .eq("claim_id", claimId)
        .eq("subject_type", "sof_chase")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

  const confirmed = (events ?? []).map((e) => ({
    event_type: e.event_type,
    occurred_at: e.occurred_at,
  }));

  const timeBar = computeTimeBar({
    timeBarDays: claim.time_bar_days ?? 90,
    events: confirmed,
    hasSofDocument: (docCount ?? 0) > 0,
    hasValidCpTerms: claim.cp_terms != null,
    hasCalculation: !!calc,
    now,
  });

  const hasNoticeDraft = (drafts ?? []).length > 0;
  const lastPayload = reviews?.[0]?.payload as { gap_signature?: string } | undefined;

  return {
    id: claimId,
    settled: claim.settled_at != null,
    notice: evaluateProtectiveNotice({
      timeBar,
      alreadyFiled: hasNoticeDraft,
      settled: claim.settled_at != null,
      leadDays: opts.leadDays,
    }),
    gaps: detectSofGaps({
      events: confirmed,
      now: now.toISOString(),
      staleAfterHours: opts.staleAfterHours,
    }),
    hasNoticeDraft,
    lastChaseSignature: lastPayload?.gap_signature ?? null,
  };
}

/**
 * Drafts one document and queues it for human approval.
 *
 * A 23505 on the review insert means a request for this claim and subject is
 * already pending — a concurrent sweep won that race. The draft is kept
 * (it cost an LLM call and is perfectly good) but no second review is queued.
 */
async function draftAndQueue(
  claimId: string,
  kind: DraftKind,
  subjectType: string,
  supabase: SupabaseClient,
  payload: Record<string, unknown>
): Promise<void> {
  const draft = await generateDraft(claimId, kind, "neutral", supabase);

  const { data: saved, error: draftErr } = await supabase
    .from("drafts")
    .insert({
      claim_id: claimId,
      kind,
      tone: "neutral",
      subject: draft.subject,
      content_md: draft.contentMd,
      position_analysis: draft.positionAnalysis,
      grounding: draft.grounding,
      model: draft.model,
    })
    .select("id")
    .single();
  if (draftErr || !saved) throw new Error(`DRAFT_PERSIST_FAILED: ${draftErr?.message}`);

  const { error: reviewErr } = await supabase.from("pending_human_reviews").insert({
    claim_id: claimId,
    subject_type: subjectType,
    subject_id: saved.id,
    summary: draft.subject,
    payload: { ...payload, grounding_verified: draft.grounding.verified },
    requested_by: "notice-sweep",
  });
  if (reviewErr && reviewErr.code !== "23505") {
    throw new Error(`REVIEW_PERSIST_FAILED: ${reviewErr.message}`);
  }
}

export async function runNoticeSweep(
  supabase: SupabaseClient,
  opts: NoticeSweepOptions = {}
): Promise<NoticeSweepReport> {
  const report: NoticeSweepReport = {
    scanned: 0,
    noticesDue: 0,
    noticesDrafted: 0,
    chasesDue: 0,
    chasesDrafted: 0,
    skipped: 0,
    errors: [],
  };

  let claimIds: string[];
  if (opts.claimId) {
    claimIds = [opts.claimId];
  } else {
    let query = supabase
      .from("claims")
      .select("id")
      .is("settled_at", null)
      .order("updated_at", { ascending: false })
      .limit(opts.limit ?? DEFAULT_SWEEP_LIMIT);
    if (opts.companyId) query = query.eq("company_id", opts.companyId);
    const { data, error } = await query;
    if (error) throw new Error(`SWEEP_QUERY_FAILED: ${error.message}`);
    claimIds = (data ?? []).map((c) => c.id);
  }

  // One instant for the whole sweep, so every claim is judged against the same
  // "now" and a re-run over unchanged data reaches the same verdicts.
  const now = new Date();

  for (const claimId of claimIds) {
    report.scanned += 1;
    try {
      const facts = await gatherFacts(claimId, supabase, now, opts);

      // --- Protective notice ---
      if (facts.notice.due) {
        report.noticesDue += 1;
        if (!opts.dryRun) {
          await draftAndQueue(claimId, "protective_notice", "protective_notice", supabase, {
            deadline: facts.notice.deadline,
            days_remaining: facts.notice.daysRemaining,
            missing: facts.notice.missing,
            reason: facts.notice.reason,
          });
          report.noticesDrafted += 1;
        }
      }

      // --- SoF chase ---
      // Settled claims are excluded by the sweep query, but a single-claim run
      // can target one directly; there is nothing to chase on a closed voyage.
      const chaseDue =
        facts.gaps.gaps.length > 0 &&
        !facts.settled &&
        facts.gaps.signature !== facts.lastChaseSignature;

      if (chaseDue) {
        report.chasesDue += 1;
        if (!opts.dryRun) {
          await draftAndQueue(claimId, "sof_chase", "sof_chase", supabase, {
            gap_signature: facts.gaps.signature,
            gaps: facts.gaps.gaps,
            quiet_for_hours: facts.gaps.quietForHours,
          });
          report.chasesDrafted += 1;
        }
      }

      if (!facts.notice.due && !chaseDue) report.skipped += 1;
    } catch (e) {
      // One bad claim must not end the sweep — the rest of the book still needs
      // its deadlines watched.
      report.errors.push({
        claimId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}
