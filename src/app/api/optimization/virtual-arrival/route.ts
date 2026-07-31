import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { planVirtualArrival } from "@/lib/optimization/virtual-arrival";
import { selectCongestionAdapter } from "@/lib/risk/sources/resolve-congestion";
import type { ConsumptionCurve } from "@/lib/compliance/carbon";
import {
  referenceCurve,
  VESSEL_CLASSES,
  type VesselClass,
} from "@/lib/optimization/reference-curves";

// Virtual Arrival: the port's live queue, turned into a speed instruction.
//
// This is the wiring the eco-speed optimizer was always missing. It priced
// every arrival speed correctly but had to be TOLD how long the queue was;
// now the AIS congestion adapter supplies it, with the same provenance
// discipline as the risk engine — an unmeasurable queue is refused rather than
// defaulted to zero, because telling a master to keep steaming into an unknown
// port is the expensive direction to be wrong in.

const BodySchema = z.object({
  vesselImo: z.string().min(1).max(32).optional(),
  port: z.string().min(2).max(80),
  currentSpeedKnots: z.number().min(0.5).max(30),
  distanceToPortNm: z.number().min(1).max(20000),
  demurrageRatePerDay: z.number().min(0).max(1_000_000),
  laytimeBufferHours: z.number().min(0).max(720).optional(),
  cancellingAt: z.string().datetime({ offset: true }).nullish(),
  fixtureLossUsd: z.number().min(0).optional(),
  fuelPriceUsdPerTonne: z.number().min(0).optional(),
  queuePercentile: z.number().min(0).max(1).optional(),
  /** Waiting-hour observations supplied by the desk, when the feed is unusable. */
  assumedWaitingHours: z.array(z.number().min(0).max(2000)).max(500).nullish(),
  consumptionCurve: z
    .object({
      sea_curve: z
        .array(
          z.object({
            speed_knots: z.number().min(1).max(30),
            tonnes_per_day: z.number().min(0).max(500),
          })
        )
        .min(2),
      at_berth_aux_tonnes_per_day: z.number().min(0).max(100),
    })
    .optional(),
  /**
   * A generic curve for the class, when the vessel's own is not on file.
   * Explicitly not decision-grade — see reference-curves.ts.
   */
  vesselClass: z.enum(["handysize", "supramax", "panamax", "capesize"]).optional(),
});

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

    // The vessel's own consumption curve when we hold one; otherwise the caller
    // must supply it. There is no generic fallback curve on purpose — fuel burn
    // is hull-specific, and a made-up curve produces a confident speed
    // instruction for a ship that does not behave that way.
    let curve: ConsumptionCurve | null = body.consumptionCurve
      ? (body.consumptionCurve as ConsumptionCurve)
      : null;

    if (!curve && body.vesselImo) {
      // `vessel_analytics_profiles`, keyed on `vessel_imo` — the same table the
      // eco-speed route reads. Verified against the catalog: there is no
      // `vessel_profiles`, and TypeScript cannot see a wrong table name here.
      const { data: profile } = await supabase
        .from("vessel_analytics_profiles")
        .select("consumption_curve")
        .eq("company_id", auth.companyId)
        .eq("vessel_imo", body.vesselImo)
        .maybeSingle();
      const stored = (profile as { consumption_curve?: ConsumptionCurve } | null)
        ?.consumption_curve;
      if (stored?.sea_curve?.length) curve = stored;
    }

    // A generic class curve is the LAST resort, and it costs the plan its
    // decision-grade status — same discipline as the mock congestion feed.
    let curveIsGeneric = false;
    let curveSource = "Vessel's own consumption curve";
    if (!curve && body.vesselClass) {
      const ref = referenceCurve(body.vesselClass as VesselClass);
      curve = ref.curve;
      curveIsGeneric = true;
      curveSource = ref.sourceLabel;
    }

    if (!curve) {
      return NextResponse.json(
        {
          error: "NO_CONSUMPTION_CURVE",
          message:
            "No fuel consumption curve is on file for this vessel and none was supplied. Fuel burn is hull-specific, so a speed recommendation cannot be produced without one. Supply a curve, a vesselImo with a stored profile, or a vesselClass for a clearly-labelled generic reference.",
          vesselClasses: VESSEL_CLASSES,
        },
        { status: 422 }
      );
    }

    // ── The queue ─────────────────────────────────────────────────────────
    let waitingHoursSorted: number[] = [];
    let vesselsAtAnchorage: number | null = null;
    let observedAt: string | null = null;
    let provenance;

    if (body.assumedWaitingHours && body.assumedWaitingHours.length > 0) {
      waitingHoursSorted = [...body.assumedWaitingHours].sort((a, b) => a - b);
      provenance = {
        source: "assumption" as const,
        provider: "user",
        observedAt: null,
        label: `${waitingHoursSorted.length} waiting-hour figures supplied by the requester`,
      };
    } else {
      const { adapter, reason } = selectCongestionAdapter(process.env);
      const snapshot = adapter ? await adapter.fetchSnapshot(body.port) : null;

      if (!snapshot || snapshot.waitingHoursSorted.length === 0) {
        return NextResponse.json(
          {
            error: "CONGESTION_UNAVAILABLE",
            message: `${
              reason ??
              (adapter
                ? `The ${adapter.id} provider returned no waiting times for ${body.port}.`
                : "No congestion provider is available.")
            } Supply assumedWaitingHours to plan on a stated assumption instead.`,
          },
          { status: 422 }
        );
      }
      waitingHoursSorted = snapshot.waitingHoursSorted;
      vesselsAtAnchorage = snapshot.vesselsAtAnchorage;
      observedAt = snapshot.observedAt;
      provenance = snapshot.provenance;
    }

    const plan = planVirtualArrival({
      telemetry: {
        currentSpeedKnots: body.currentSpeedKnots,
        distanceToPortNm: body.distanceToPortNm,
      },
      consumptionCurve: curve,
      demurrageRatePerDay: body.demurrageRatePerDay,
      nowISO: new Date().toISOString(),
      laytimeBufferHours: body.laytimeBufferHours,
      cancellingAt: body.cancellingAt ?? undefined,
      fixtureLossUsd: body.fixtureLossUsd,
      fuelPriceUsdPerTonne: body.fuelPriceUsdPerTonne,
      queuePercentile: body.queuePercentile,
      queue: { waitingHoursSorted, vesselsAtAnchorage, observedAt, provenance },
    });

    return NextResponse.json({
      port: body.port,
      // Surfaced at the top level, as on the risk routes: a plan built on a
      // mock queue must be impossible to mistake for a measured one.
      decisionGrade: provenance.source !== "mock" && !curveIsGeneric,
      curve: { generic: curveIsGeneric, source: curveSource },
      queue: {
        hoursUsed: plan.queueHours,
        percentile: plan.queuePercentile,
        spread: plan.queueSpread,
        observations: plan.observationCount,
        vesselsAtAnchorage,
        observedAt,
      },
      action: plan.recommendation.action,
      recommendation: plan.recommendation.recommendation,
      current: plan.recommendation.current,
      optimal: plan.recommendation.optimal,
      savings: plan.savings,
      sensitivity: plan.sensitivity,
      actionRobust: plan.actionRobust,
      assumptions: plan.recommendation.assumptions,
      evidence: plan.recommendation.evidence,
      provenance: plan.provenance,
      caveats: curveIsGeneric
        ? [
            `GENERIC HULL: ${curveSource}. Fuel and carbon figures are indicative only — load this vessel's own consumption curve before acting on the speed.`,
            ...plan.caveats,
          ]
        : plan.caveats,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("CONGESTION_UNAVAILABLE")) {
      return NextResponse.json(
        { error: "CONGESTION_UNAVAILABLE", message: message.replace(/^CONGESTION_UNAVAILABLE:\s*/, "") },
        { status: 422 }
      );
    }
    return apiError(e, "optimization/virtual-arrival", {
      NO_QUEUE_OBSERVATIONS: 422,
      INVALID_TELEMETRY: 400,
      INVALID_CONSUMPTION_CURVE: 400,
      INVALID_SPEED_RANGE: 400,
    });
  }
}
