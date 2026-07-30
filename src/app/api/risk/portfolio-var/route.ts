import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  simulatePortfolio,
  DEFAULT_CLUSTERING,
  DEFAULT_PORTFOLIO_TRIALS,
  MAX_PORTFOLIO_TRIALS,
  type PortfolioVoyage,
} from "@/lib/risk/portfolio-var";
import { inputsToTrialInputs, type PersistedInputs } from "@/lib/risk/assess-server";

// Portfolio demurrage Value-at-Risk across a book of stored pre-arrival
// assessments.
//
// WHY IT REPLAYS STORED ASSESSMENTS RATHER THAN RE-FETCHING WEATHER: each
// `pre_arrival_risks` row already carries the complete resolved inputs —
// trajectories, queue ECDF, cargo thresholds — that reproduce its figures to
// the cent. Rebuilding them from live APIs would price the book against a
// forecast issued after the individual assessments were published, so the
// portfolio number would not reconcile with its own parts. Replay keeps the two
// consistent, and makes this endpoint fast and free.
//
// It also means the portfolio result inherits the audit property: every input
// is already stored and digested.

const BodySchema = z.object({
  /** Assessment ids to include. Omit to use the whole open book. */
  riskIds: z.array(z.string().uuid()).min(1).max(200).optional(),
  seed: z.string().min(1).max(200).optional(),
  trials: z.number().int().min(100).max(MAX_PORTFOLIO_TRIALS).optional(),
  antithetic: z.boolean().optional(),
  clustering: z
    .object({
      radiusKm: z.number().min(0).max(5000),
      requireTimeOverlap: z.boolean(),
    })
    .optional(),
  /**
   * Include assessments whose inputs came from a mock provider.
   *
   * Off by default: one synthetic voyage would quietly contaminate a book-level
   * figure that reads as measurement, and the portfolio number is exactly the
   * kind a treasurer acts on.
   */
  includeNonDecisionGrade: z.boolean().optional(),
});

interface RiskRow {
  id: string;
  vessel: string;
  voyage_ref: string | null;
  port: string;
  eta: string;
  currency: string;
  decision_grade: boolean;
  inputs: PersistedInputs;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const body = parsed.data;
    const supabase = await createClient();

    let query = supabase
      .from("pre_arrival_risks")
      .select("id, vessel, voyage_ref, port, eta, currency, decision_grade, inputs")
      .eq("company_id", auth.companyId)
      .order("eta", { ascending: true })
      .limit(200);

    if (body.riskIds) query = query.in("id", body.riskIds);
    if (!body.includeNonDecisionGrade) query = query.eq("decision_grade", true);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as RiskRow[];
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error: "NO_ASSESSMENTS",
          message: body.includeNonDecisionGrade
            ? "No pre-arrival assessments were found for this company."
            : "No decision-grade pre-arrival assessments were found. Assessments built on synthetic congestion are excluded by default; pass includeNonDecisionGrade to see them anyway, clearly marked.",
        },
        { status: 422 }
      );
    }

    // Mixed currencies cannot be summed. Refusing is the only honest answer —
    // silently adding USD to EUR would produce a confident, meaningless number.
    const currencies = [...new Set(rows.map((r) => r.currency))];
    if (currencies.length > 1) {
      return NextResponse.json(
        {
          error: "MIXED_CURRENCIES",
          message:
            `The selected book spans ${currencies.join(", ")}. A portfolio total requires one ` +
            `currency; convert, or select assessments in a single currency.`,
        },
        { status: 422 }
      );
    }

    const voyages: PortfolioVoyage[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const r of rows) {
      // Position is needed to decide which weather system a voyage sits in.
      // Older rows predate it, so they are reported as skipped rather than
      // silently defaulted to (0,0) — which would put them all in the Gulf of
      // Guinea and invent a correlation.
      const pos = (r.inputs as unknown as { position?: { lat: number; lon: number } }).position;
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) {
        skipped.push({
          id: r.id,
          reason: "The stored assessment carries no port position, so its weather system cannot be determined.",
        });
        continue;
      }
      voyages.push({
        id: r.id,
        label: `${r.vessel} — ${r.port}`,
        position: { lat: pos.lat, lon: pos.lon },
        inputs: inputsToTrialInputs(r.inputs),
      });
    }

    if (voyages.length === 0) {
      return NextResponse.json(
        {
          error: "NO_POSITIONED_ASSESSMENTS",
          message:
            "None of the selected assessments carries a port position, so no weather systems could be formed. Re-run the pre-arrival assessments to record positions.",
          skipped,
        },
        { status: 422 }
      );
    }

    const report = simulatePortfolio(voyages, {
      seed: body.seed?.trim() || `portfolio:${auth.companyId}:${voyages.map((v) => v.id).sort().join(",")}`,
      trials: body.trials ?? DEFAULT_PORTFOLIO_TRIALS,
      currency: currencies[0],
      antithetic: body.antithetic,
      clustering: body.clustering ?? DEFAULT_CLUSTERING,
    });

    const anySynthetic = rows.some((r) => !r.decision_grade);

    return NextResponse.json({
      ...report,
      decisionGrade: !anySynthetic,
      skipped,
      caveats: [
        ...(anySynthetic
          ? [
              "SYNTHETIC DATA: at least one assessment in this book was built on a mock provider. The portfolio figures are for testing and demonstration only.",
            ]
          : []),
        "Figures are replayed from each assessment's stored inputs, so they reconcile exactly with the individual assessments rather than being re-priced against a newer forecast.",
        "Correlated is the figure to act on. The independent run is a counterfactual shown so the correlation effect can be seen; it is not a second opinion.",
      ],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("DUPLICATE_VOYAGE_ID") || message.startsWith("NO_VOYAGES")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return apiError(e, "risk/portfolio-var", {
      NO_WEATHER_TRAJECTORIES: 422,
      NO_CONGESTION_SAMPLES: 422,
    });
  }
}
