import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { computeFuelEu } from "@/lib/compliance/fueleu";
import { apiError } from "@/lib/api-errors";

// FuelEU Maritime compliance calculator — Reg (EU) 2023/1805.
//
// Stateless and company-agnostic: a fuel mix + year in, the GHG-intensity
// balance and Annex IV penalty out. Session-gated (a tool for logged-in
// operators) but writes nothing — the whole computation is the pure
// computeFuelEu(). The regulation's ill-defined cases surface as FUELEU_*
// sentinels, mapped here to 422 so the UI can show WHY (year too early, a
// pathway-dependent fuel with no supplied intensity) rather than an opaque 500.

const FuelEnum = z.enum([
  "HFO",
  "LFO",
  "MDO/MGO",
  "LNG",
  "LPG-propane",
  "LPG-butane",
  "methanol",
  "ethanol",
]);

const Schema = z.object({
  year: z.number().int().min(2025).max(2100),
  fuels: z
    .array(
      z.object({
        fuel: FuelEnum,
        tonnes: z.number().min(0),
        wtwIntensity: z.number().min(0).max(500).optional(),
      })
    )
    .min(1)
    .max(20),
  penaltyEurPerTonne: z.number().min(0).optional(),
});

export async function POST(req: NextRequest) {
  try {
    await requireAuth();
    const parsed = Schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    try {
      const result = computeFuelEu(parsed.data);
      return NextResponse.json({ result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("FUELEU_")) {
        return NextResponse.json({ error: msg }, { status: 422 });
      }
      throw e;
    }
  } catch (e) {
    return apiError(e, "compliance/fueleu/POST");
  }
}
