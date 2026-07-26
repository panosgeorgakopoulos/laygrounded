import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { InboundClaimInputSchema } from "@/lib/defense/service";

const KNOWN = {
  INBOUND_CLAIM_NOT_FOUND: 404,
  INVALID_CLAIMANT_EVENTS: 400,
} as const;

// The inbound book: demurrage claims made against us.
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("inbound_claims")
      .select(
        "id, claimant_name, vessel, voyage_ref, port, cargo, claimed_amount, currency, " +
          "received_at, respond_by, status, resolved_amount, " +
          "inbound_claim_audits(defensible_position, total_challenged, arithmetic_delta, computed_at)",
      )
      .eq("company_id", auth.companyId)
      .order("received_at", { ascending: false });

    if (error) throw error;

    // The embedded audit makes Supabase's inferred row type a union that
    // includes its error shape; the query is checked above, so the rows are cast
    // once here rather than threading that union through the mapping.
    const rows = (data ?? []) as unknown as Array<Record<string, any>>;

    return NextResponse.json({
      claims: rows.map((c) => {
        // Supabase returns an embedded one-to-one as an array or an object
        // depending on how it infers the relationship; normalise both.
        const raw = c.inbound_claim_audits;
        const audit = Array.isArray(raw) ? raw[0] : raw;
        return {
          id: c.id,
          claimantName: c.claimant_name,
          vessel: c.vessel,
          voyageRef: c.voyage_ref,
          port: c.port,
          cargo: c.cargo,
          claimedAmount: Number(c.claimed_amount),
          currency: c.currency,
          receivedAt: c.received_at,
          respondBy: c.respond_by,
          status: c.status,
          resolvedAmount: c.resolved_amount === null ? null : Number(c.resolved_amount),
          audit: audit
            ? {
                defensiblePosition: Number(audit.defensible_position),
                totalChallenged: Number(audit.total_challenged),
                arithmeticDelta: Number(audit.arithmetic_delta),
                computedAt: audit.computed_at,
              }
            : null,
        };
      }),
    });
  } catch (e) {
    return apiError(e, "defense/claims/GET", KNOWN);
  }
}

// Record a claim received from a counterparty.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = InboundClaimInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("inbound_claims")
      .insert({
        company_id: auth.companyId,
        created_by: auth.userId,
        claimant_name: input.claimantName,
        vessel: input.vessel,
        voyage_ref: input.voyageRef ?? null,
        port: input.port ?? null,
        cargo: input.cargo ?? null,
        claimed_amount: input.claimedAmount,
        currency: input.currency,
        claimant_events: input.claimantEvents,
        claimant_cp_terms: input.claimantCpTerms,
        our_cp_terms: input.ourCpTerms ?? null,
        respond_by: input.respondBy ?? null,
      })
      .select("id")
      .single();

    if (error) throw error;
    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (e) {
    return apiError(e, "defense/claims/POST", KNOWN);
  }
}
