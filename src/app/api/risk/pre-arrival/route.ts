import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { apiError } from "@/lib/api-errors";
import { assessPreArrivalRisk, persistAssessment } from "@/lib/risk/assess-server";
import { MAX_TRIALS, MIN_TRIALS } from "@/lib/risk/simulate";

// Pre-arrival demurrage risk.
//
// POST runs a simulation and stores it; GET lists this company's assessments.
//
// The stored row is the deliverable, not a side effect: it carries the seed and
// the complete resolved inputs, so the figures can be re-derived by anyone
// holding the row long after the forecast that produced them has expired.
//
// `decisionGrade` is surfaced at the TOP of the response, not buried in the
// provenance object. A synthetic-congestion run is legitimate for testing and
// must be impossible to mistake for a measured one at a glance.

const CpTermsSchema = z.object({
  cp_form: z.enum(["GENCON94", "ASBATANKVOY"]).optional(),
  laytime_allowed_hours: z.number().min(1).max(1000).optional(),
  turn_time_hours: z.number().min(0).max(72).optional(),
  nor_variant: z.enum(["WIBON", "WIPON", "WICCON", "WIFPON"]).optional(),
  days_basis: z
    .enum(["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"])
    .optional(),
  demurrage_rate: z.number().min(0).optional(),
  despatch_rate: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  port_timezone: z.string().optional(),
});

const AssessSchema = z.object({
  vessel: z.string().min(1).max(120),
  voyageRef: z.string().max(80).nullish(),
  port: z.string().min(2).max(80),
  cargo: z.string().min(1).max(120),
  eta: z.string().datetime({ offset: true }),
  operation: z.enum(["loading", "discharge"]).optional(),
  opsDurationHours: z.number().int().min(1).max(480),
  berthToOpsHours: z.number().int().min(0).max(72).optional(),
  etaErrorHours: z
    .object({
      min: z.number().min(-336).max(0),
      mode: z.number().min(-336).max(336),
      max: z.number().min(0).max(336),
    })
    // A mode outside [min, max] would silently clamp inside the sampler and
    // simulate something other than what was asked for.
    .refine((e) => e.min <= e.mode && e.mode <= e.max, {
      message: "etaErrorHours.mode must lie between min and max",
    })
    .optional(),
  assumedWaitingHours: z.array(z.number().min(0).max(2000)).max(500).nullish(),
  cpTerms: CpTermsSchema.optional(),
  seed: z.string().min(1).max(200).optional(),
  trials: z.number().int().min(MIN_TRIALS).max(MAX_TRIALS).optional(),
  antithetic: z.boolean().optional(),
  claimId: z.string().uuid().nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = AssessSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const body = parsed.data;
    const supabase = await createClient();

    // Defense in depth alongside RLS, as every claim-scoped route does: an
    // optional back-link must not become a way to attach a row to someone
    // else's claim.
    if (body.claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("id, company_id")
        .eq("id", body.claimId)
        .maybeSingle();
      if (!claim || claim.company_id !== auth.companyId) {
        return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
      }
    }

    const assessment = await assessPreArrivalRisk(supabase, auth.companyId, {
      vessel: body.vessel,
      voyageRef: body.voyageRef ?? null,
      port: body.port,
      cargo: body.cargo,
      etaISO: new Date(body.eta).toISOString(),
      cpTerms: { ...DEFAULT_CP_TERMS, ...body.cpTerms },
      opsDurationHours: body.opsDurationHours,
      operation: body.operation,
      berthToOpsHours: body.berthToOpsHours,
      etaErrorHours: body.etaErrorHours,
      assumedWaitingHours: body.assumedWaitingHours ?? null,
      seed: body.seed,
      trials: body.trials,
      antithetic: body.antithetic,
      claimId: body.claimId ?? null,
    });

    const id = await persistAssessment(
      supabase,
      auth.companyId,
      auth.userId,
      {
        vessel: body.vessel,
        voyageRef: body.voyageRef ?? null,
        port: body.port,
        cargo: body.cargo,
        etaISO: new Date(body.eta).toISOString(),
        cpTerms: { ...DEFAULT_CP_TERMS, ...body.cpTerms },
        opsDurationHours: body.opsDurationHours,
        operation: body.operation,
        claimId: body.claimId ?? null,
      },
      assessment
    );

    return NextResponse.json({
      id,
      decisionGrade: assessment.decisionGrade,
      vessel: body.vessel,
      port: assessment.portLabel,
      cargo: body.cargo,
      eta: body.eta,
      horizon: assessment.horizon,
      seed: assessment.simulation.seed,
      trials: assessment.simulation.trials,
      antithetic: assessment.simulation.antithetic,
      inputsDigest: assessment.inputsDigest,
      distribution: assessment.simulation.distribution,
      provenance: assessment.provenance,
      caveats: assessment.caveats,
    });
  } catch (e) {
    // `CONGESTION_UNAVAILABLE` carries its remedy in the message — which env
    // var to set, or to supply `assumedWaitingHours`. apiError matches
    // sentinels exactly, so this one is handled here rather than flattened
    // into an opaque 500 that tells an integrator nothing.
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("CONGESTION_UNAVAILABLE")) {
      return NextResponse.json(
        { error: "CONGESTION_UNAVAILABLE", message: message.replace(/^CONGESTION_UNAVAILABLE:\s*/, "") },
        { status: 422 }
      );
    }
    return apiError(e, "risk/pre-arrival", {
      PORT_NOT_FOUND: 422,
      WEATHER_UNAVAILABLE: 422,
      NO_WEATHER_TRAJECTORIES: 422,
      NO_CONGESTION_SAMPLES: 422,
    });
  }
}

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("pre_arrival_risks")
      // One string literal, not a concatenation: supabase-js parses the select
      // list at the type level, and a runtime-built string collapses the row
      // type to GenericStringError.
      .select("id, vessel, voyage_ref, port, cargo, eta, operation, seed, trials, decision_grade, demurrage_probability, expected_exposure, p90_exposure, currency, lead_time_hours, horizon_mode, inputs_digest, created_at, claim_id")
      .eq("company_id", auth.companyId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw new Error(error.message);

    return NextResponse.json({
      assessments: (data ?? []).map((r) => ({
        id: r.id,
        vessel: r.vessel,
        voyageRef: r.voyage_ref,
        port: r.port,
        cargo: r.cargo,
        eta: r.eta,
        operation: r.operation,
        seed: r.seed,
        trials: r.trials,
        decisionGrade: r.decision_grade,
        demurrageProbability: r.demurrage_probability,
        expectedExposure: r.expected_exposure,
        p90Exposure: r.p90_exposure,
        currency: r.currency,
        leadTimeHours: r.lead_time_hours,
        horizonMode: r.horizon_mode,
        inputsDigest: r.inputs_digest,
        claimId: r.claim_id,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    return apiError(e, "risk/pre-arrival:list");
  }
}
