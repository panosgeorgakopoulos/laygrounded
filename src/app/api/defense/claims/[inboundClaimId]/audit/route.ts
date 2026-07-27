import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { auditAndPersist } from "@/lib/defense/service";

const KNOWN = {
  INBOUND_CLAIM_NOT_FOUND: 404,
  INVALID_CLAIMANT_EVENTS: 400,
} as const;

// Evidence the auditor supplies from their own records. Every field is
// optional: an audit with no evidence still catches arithmetic and terms
// errors, and the result says plainly what it could not check.
const EvidenceSchema = z.object({
  norContradictedArrivalIso: z.string().datetime({ offset: true }).optional(),
  unrecordedWeatherWindows: z
    .array(
      z.object({
        startIso: z.string().datetime({ offset: true }),
        endIso: z.string().datetime({ offset: true }),
        source: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .optional(),
  contradictedCompletionIso: z.string().datetime({ offset: true }).optional(),
  inconclusiveChecks: z.number().int().min(0).max(1000).optional(),
  evidenceUnavailable: z.boolean().optional(),
  clauseFlags: z
    .array(
      z.object({
        eventId: z.string().optional(),
        severity: z.string().max(40),
        label: z.string().max(300),
        clauseRef: z.string().max(60),
      }),
    )
    .max(50)
    .optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ inboundClaimId: string }> },
) {
  try {
    const auth = await requireAuth();
    const { inboundClaimId } = await params;

    const parsed = EvidenceSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    for (const w of parsed.data.unrecordedWeatherWindows ?? []) {
      if (new Date(w.endIso) <= new Date(w.startIso)) {
        return NextResponse.json(
          { error: "VALIDATION_ERROR", details: "A weather window must end after it starts." },
          { status: 400 },
        );
      }
    }

    const supabase = await createClient();
    const result = await auditAndPersist(supabase, inboundClaimId, auth.companyId, parsed.data);
    return NextResponse.json({ audit: result });
  } catch (e) {
    return apiError(e, "defense/claims/audit/POST", KNOWN);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ inboundClaimId: string }> },
) {
  try {
    const auth = await requireAuth();
    const { inboundClaimId } = await params;
    const supabase = await createClient();

    // The join pins the tenant: the audit is only readable through an inbound
    // claim this company owns.
    const { data: claim } = await supabase
      .from("inbound_claims")
      .select("id, company_id")
      .eq("id", inboundClaimId)
      .maybeSingle();

    if (!claim || claim.company_id !== auth.companyId) {
      throw new Error("INBOUND_CLAIM_NOT_FOUND");
    }

    const { data: audit } = await supabase
      .from("inbound_claim_audits")
      .select("*")
      .eq("inbound_claim_id", inboundClaimId)
      .maybeSingle();

    return NextResponse.json({ audit: audit ?? null });
  } catch (e) {
    return apiError(e, "defense/claims/audit/GET", KNOWN);
  }
}
