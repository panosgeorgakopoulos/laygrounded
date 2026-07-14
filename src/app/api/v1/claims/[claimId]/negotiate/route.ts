import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  executeAgenticArbitration,
  MAX_NEGOTIATION_ROUNDS,
  NEGOTIATION_CATEGORIES,
  type NegotiationCategory,
} from "@/lib/negotiation/autonomous";
import type { CpTerms, EventTypeEnum } from "@/lib/laytime/types";

const CategoryEnum = z.enum(
  NEGOTIATION_CATEGORIES as [NegotiationCategory, ...NegotiationCategory[]]
);

const LimitsSchema = z.object({
  maxConcessionUsd: z.number().min(0),
  hardStopClauses: z.array(CategoryEnum).max(NEGOTIATION_CATEGORIES.length).default([]),
});

const NegotiateSchema = z.object({
  ownerLimits: LimitsSchema,
  chartererLimits: LimitsSchema,
  maxRounds: z.number().int().min(1).max(MAX_NEGOTIATION_ROUNDS).optional(),
});

// Agent-to-agent micro-negotiation: two deterministic strategy agents trade
// evidence-grounded concessions over the claim's sensitivity agenda and
// produce a SettlementMatrix. The run is persisted to
// autonomous_negotiation_rooms and the recommendation queued behind a
// pending_human_reviews row — nothing settles until a human clicks.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();

    const parsed = NegotiateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, cp_terms")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
    if (!claim.cp_terms) throw new Error("NO_CP_TERMS");

    const [{ data: events }, { data: evidence }] = await Promise.all([
      supabase
        .from("sof_events")
        .select("id, event_type, occurred_at")
        .eq("claim_id", claimId)
        .in("status", ["accepted", "edited"])
        .order("occurred_at", { ascending: true }),
      supabase.from("evidence_checks").select("event_id, verdict").eq("claim_id", claimId),
    ]);
    if (!events || events.length === 0) throw new Error("NO_CONFIRMED_EVENTS");

    const matrix = executeAgenticArbitration(claimId, {
      events: events.map((e) => ({
        id: e.id,
        occurred_at: e.occurred_at,
        event_type: e.event_type as EventTypeEnum,
      })),
      cpTerms: claim.cp_terms as CpTerms,
      evidence: (evidence ?? []).map((v) => ({
        eventId: v.event_id,
        verdict: v.verdict as "corroborated" | "contradicted" | "inconclusive" | "unavailable",
      })),
      ownerLimits: parsed.data.ownerLimits,
      chartererLimits: parsed.data.chartererLimits,
      maxRounds: parsed.data.maxRounds,
    });

    // max_concession_usd / hard_stop_clauses columns record OUR side's
    // mandate (the owner agent); the charterer agent's limits travel inside
    // the matrix JSON.
    const { data: room, error: roomErr } = await supabase
      .from("autonomous_negotiation_rooms")
      .insert({
        claim_id: claimId,
        company_id: auth.companyId,
        max_concession_usd: parsed.data.ownerLimits.maxConcessionUsd,
        hard_stop_clauses: parsed.data.ownerLimits.hardStopClauses,
        agent_rounds_completed: matrix.roundsCompleted,
        final_settlement_probability: matrix.settlementProbability,
        settlement_matrix: { ...matrix, chartererLimits: parsed.data.chartererLimits },
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (roomErr || !room) throw new Error(`PERSIST_FAILED: ${roomErr?.message}`);

    // HITL gate: one live review per claim; a duplicate means a previous
    // matrix is still awaiting a human decision.
    let review = "queued";
    const { error: reviewErr } = await supabase.from("pending_human_reviews").insert({
      claim_id: claimId,
      subject_type: "autonomous_settlement",
      subject_id: room.id,
      summary: `Agents recommend settling at ${matrix.currency} ${matrix.recommendedSettlement.toLocaleString("en-US")} after ${matrix.roundsCompleted} round(s) (probability ${matrix.settlementProbability}, ${matrix.converged ? "converged" : "gap remains"}).`,
      payload: {
        recommended_settlement: matrix.recommendedSettlement,
        gap: matrix.gap,
        converged: matrix.converged,
        settlement_probability: matrix.settlementProbability,
        room_id: room.id,
      },
      requested_by: auth.email,
    });
    if (reviewErr) {
      if (reviewErr.code === "23505") review = "already_pending";
      else throw new Error(`PERSIST_FAILED: ${reviewErr.message}`);
    }

    return NextResponse.json({ roomId: room.id, matrix, review }, { status: 201 });
  } catch (e) {
    return apiError(e, "v1/claims/negotiate/POST", {
      NO_CONFIRMED_EVENTS: 409,
      INVALID_LIMITS: 400,
    });
  }
}

// Negotiation history for the claim — newest first.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const { data: rooms } = await supabase
      .from("autonomous_negotiation_rooms")
      .select(
        "id, status, max_concession_usd, hard_stop_clauses, agent_rounds_completed, final_settlement_probability, settlement_matrix, created_at"
      )
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(20);

    return NextResponse.json({ rooms: rooms ?? [] });
  } catch (e) {
    return apiError(e, "v1/claims/negotiate/GET");
  }
}
