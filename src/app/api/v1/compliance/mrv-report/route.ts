import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { generateAndSealMrvReport, type MrvVoyageOverride } from "@/lib/compliance/mrv-server";
import { EU_MRV_EMISSION_FACTORS } from "@/lib/compliance/mrv";

const FuelSchema = z.object({
  fuelType: z.enum(Object.keys(EU_MRV_EMISSION_FACTORS) as [string, ...string[]]),
  tonnes: z.number().positive().max(100_000),
  phase: z.enum(["at_sea", "at_berth"]),
  // Reg (EU) 2015/757 Annex I Part B. Required: an unattributed number is not
  // monitoring data, and the report has to say how each figure was measured.
  method: z.enum([
    "BDN_AND_TANK_STOCKTAKE",
    "ON_BOARD_TANK_MONITORING",
    "FLOW_METERS",
    "DIRECT_CO2_MEASUREMENT",
  ]),
});

const OverrideSchema = z.object({
  claimId: z.string().uuid(),
  fuel: z.array(FuelSchema).min(1).max(50).optional(),
  eeaPort: z.boolean().optional(),
  distanceNm: z.number().min(0).max(100_000).optional(),
  timeAtSeaHours: z.number().min(0).max(20_000).optional(),
  cargoTonnes: z.number().min(0).max(1_000_000).optional(),
});

const ReportSchema = z.object({
  reportingPeriod: z.number().int().min(2015).max(2100),
  // Measured monitoring data per voyage. Absent → those fields are reported
  // NOT MONITORED; nothing is inferred from the assumed at-berth burn rate.
  voyageData: z.array(OverrideSchema).max(500).optional(),
  // Preview without appending a seal.
  persist: z.boolean().default(true),
});

// Generates and cryptographically seals an EU MRV annual report.
//
// The report emits the Reg (EU) 2015/757 structure but never fabricates it:
// a CO2 or fuel figure appears only where measured bunker data was supplied,
// and every unmonitored field is named as such. `submittable` is false until
// the gaps close, and `verification.status` is always "unverified" — only an
// accredited verifier can verify an MRV report, via THETIS-MRV. The seal
// proves the document has not been altered since generation; it is not
// verification and confers no regulatory standing.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = ReportSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const overrides: Record<string, MrvVoyageOverride> = {};
    for (const o of parsed.data.voyageData ?? []) {
      const { claimId, ...rest } = o;
      overrides[claimId] = rest as MrvVoyageOverride;
    }

    const supabase = await createClient();
    const { report, seal, id } = await generateAndSealMrvReport({
      companyId: auth.companyId,
      companyName: auth.companyName,
      reportingPeriod: parsed.data.reportingPeriod,
      overrides,
      userId: auth.userId,
      client: supabase,
      persist: parsed.data.persist,
    });

    return NextResponse.json(
      {
        id,
        report,
        seal: {
          algo: seal.algo,
          merkleRoot: seal.merkleRoot,
          leafCount: seal.leafCount,
          asOf: seal.asOf,
          // Restated here so a client reading only the seal cannot mistake a
          // sealed report for a verified one.
          verificationStatus: seal.verificationStatus,
          submittable: seal.submittable,
        },
      },
      { status: parsed.data.persist ? 201 : 200 }
    );
  } catch (e) {
    return apiError(e, "v1/compliance/mrv-report/POST");
  }
}

// Latest sealed report for a period (or the most recent seal overall).
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const periodRaw = req.nextUrl.searchParams.get("reportingPeriod");
    const supabase = await createClient();

    let q = supabase
      .from("mrv_reports")
      .select("id, reporting_period, report, merkle_root, signature_algo, leaf_count, submittable, verification_status, sealed_at")
      .eq("company_id", auth.companyId)
      .order("sealed_at", { ascending: false })
      .limit(20);
    if (periodRaw) {
      const period = Number(periodRaw);
      if (!Number.isInteger(period)) {
        return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
      }
      q = q.eq("reporting_period", period);
    }

    const { data, error } = await q;
    if (error) throw new Error(`QUERY_FAILED: ${error.message}`);

    return NextResponse.json({
      reports: (data ?? []).map((r) => ({
        id: r.id,
        reportingPeriod: r.reporting_period,
        merkleRoot: r.merkle_root,
        algo: r.signature_algo,
        leafCount: r.leaf_count,
        submittable: r.submittable,
        verificationStatus: r.verification_status,
        sealedAt: r.sealed_at,
        report: r.report,
      })),
    });
  } catch (e) {
    return apiError(e, "v1/compliance/mrv-report/GET", { QUERY_FAILED: 503 });
  }
}
