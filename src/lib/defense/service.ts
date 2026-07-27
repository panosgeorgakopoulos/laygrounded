// Defense Mode server bridge: loads an inbound claim, runs the pure audit, and
// persists the snapshot. The DB half of `audit.ts`, which stays pure.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditInboundClaim, type DefenseAuditResult, type ClauseFlagInput } from "./audit";
import { CpTermsSchema } from "@/lib/laytime/recompute-server";
import { EVENT_TYPE_VALUES, type SofEventInput } from "@/lib/laytime/types";

// The claimant's events arrive as opaque JSON — they came off someone else's
// PDF, not out of our own pipeline — so they are validated as strictly as any
// external input before touching the engine.
export const ClaimantEventSchema = z.object({
  id: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  event_type: z.enum(EVENT_TYPE_VALUES as [string, ...string[]]),
});

export const InboundClaimInputSchema = z.object({
  claimantName: z.string().min(1).max(200),
  vessel: z.string().min(1).max(200),
  voyageRef: z.string().max(120).optional(),
  port: z.string().max(160).optional(),
  cargo: z.string().max(160).optional(),
  claimedAmount: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  claimantEvents: z.array(ClaimantEventSchema).min(1),
  claimantCpTerms: CpTermsSchema,
  ourCpTerms: CpTermsSchema.partial().optional(),
  respondBy: z.string().datetime({ offset: true }).optional(),
});

export type InboundClaimInput = z.infer<typeof InboundClaimInputSchema>;

export interface AuditEvidenceInput {
  norContradictedArrivalIso?: string;
  unrecordedWeatherWindows?: Array<{ startIso: string; endIso: string; source?: string }>;
  contradictedCompletionIso?: string;
  inconclusiveChecks?: number;
  evidenceUnavailable?: boolean;
  clauseFlags?: ClauseFlagInput[];
}

/**
 * Runs the audit for one inbound claim and stores the result.
 *
 * Replace-on-rerun: the audit table is uniquely keyed on the claim, so a second
 * run overwrites the first rather than accumulating snapshots that disagree
 * about what we are asserting.
 */
export async function auditAndPersist(
  db: SupabaseClient,
  inboundClaimId: string,
  companyId: string,
  evidence: AuditEvidenceInput = {},
): Promise<DefenseAuditResult> {
  const { data: claim, error } = await db
    .from("inbound_claims")
    .select("*")
    .eq("id", inboundClaimId)
    .maybeSingle();

  if (error) throw new Error(`AUDIT_LOAD_FAILED: ${error.message}`);
  if (!claim) throw new Error("INBOUND_CLAIM_NOT_FOUND");
  // Defence in depth: RLS already scopes this, and the ownership check is kept
  // anyway so a service-role caller cannot cross tenants.
  if (claim.company_id !== companyId) throw new Error("INBOUND_CLAIM_NOT_FOUND");

  const events = z.array(ClaimantEventSchema).safeParse(claim.claimant_events);
  if (!events.success) throw new Error("INVALID_CLAIMANT_EVENTS");

  const terms = CpTermsSchema.safeParse(claim.claimant_cp_terms);
  if (!terms.success) throw new Error("INVALID_CP_TERMS");

  const ourTerms = claim.our_cp_terms
    ? CpTermsSchema.partial().safeParse(claim.our_cp_terms)
    : null;

  const result = auditInboundClaim({
    claimedAmount: Number(claim.claimed_amount),
    events: events.data as SofEventInput[],
    cpTerms: terms.data,
    ourCpTerms: ourTerms?.success ? ourTerms.data : undefined,
    ...evidence,
  });

  const { error: upsertError } = await db.from("inbound_claim_audits").upsert(
    {
      inbound_claim_id: inboundClaimId,
      claimed_amount: result.claimedAmount,
      recomputed_amount: result.recomputedAmount,
      arithmetic_delta: result.arithmeticDelta,
      defensible_position: result.defensiblePosition,
      total_challenged: result.totalChallenged,
      currency: result.currency,
      challenges: result.challenges,
      notes: result.notes,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "inbound_claim_id" },
  );
  if (upsertError) throw new Error(`AUDIT_PERSIST_FAILED: ${upsertError.message}`);

  // An audited claim is no longer merely "received". Statuses further along
  // (challenged/settled/accepted) are set by human action, so they are not
  // walked backwards here.
  if (claim.status === "received") {
    await db
      .from("inbound_claims")
      .update({ status: "audited", updated_at: new Date().toISOString() })
      .eq("id", inboundClaimId);
  }

  return result;
}
