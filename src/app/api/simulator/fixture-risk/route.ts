import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { simulateFixtureRisk } from "@/lib/simulator/fixture-risk";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import { apiError } from "@/lib/api-errors";

const SimulateSchema = z.object({
  port: z.string().min(2).max(80),
  month: z.number().int().min(1).max(12),
  opsDurationHours: z.number().int().min(12).max(480),
  yearsBack: z.number().int().min(3).max(12).optional(),
  cpTerms: z
    .object({
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
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    await requireAuth();
    const parsed = SimulateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const report = await simulateFixtureRisk({
      port: parsed.data.port,
      month: parsed.data.month,
      opsDurationHours: parsed.data.opsDurationHours,
      yearsBack: parsed.data.yearsBack,
      cpTerms: { ...DEFAULT_CP_TERMS, ...parsed.data.cpTerms },
    });
    return NextResponse.json({ report });
  } catch (e) {
    return apiError(e, "fixture-risk/POST", { PORT_NOT_FOUND: 404 });
  }
}
