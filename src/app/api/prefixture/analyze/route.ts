import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { analyzeCharterParty } from "@/lib/prefixture/analyze-server";
import { apiError } from "@/lib/api-errors";

// Pre-fixture CP risk analyzer: paste a charter party or recap, get the
// laytime-relevant terms extracted and each risky clause priced against the
// route's own history.
//
// Reads the cross-tenant oracle matview with the service-role client, so the
// same boundary as /api/oracle/pricing applies: authenticate first, aggregates
// only in the response, no claim or company identifiers. The analyzer is
// stateless — nothing about a prospective fixture is persisted, which is also
// what makes it safe to run on a counterparty's draft terms.
const AnalyzeSchema = z.object({
  // Long enough to be a recap, capped so a pasted book cannot be used to
  // exhaust the request body limit.
  text: z.string().min(20).max(200_000),
  port: z.string().min(2).optional(),
  cargo: z.string().min(1).optional(),
  month: z.number().int().min(1).max(12),
});

export async function POST(req: NextRequest) {
  try {
    await requireAuth();

    const parsed = AnalyzeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const service = createServiceRoleClient();
    const result = await analyzeCharterParty(parsed.data, supabase, service);

    return NextResponse.json({ result });
  } catch (e) {
    return apiError(e, "prefixture/analyze/POST");
  }
}
