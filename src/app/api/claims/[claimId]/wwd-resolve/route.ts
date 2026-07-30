import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runWwdResolver } from "@/lib/weather/wwd-server";
import { apiError } from "@/lib/api-errors";

// Weather Working Day resolver, on demand.
//
// Deliberately not automatic on ingest: it costs an archive call per run, and
// nobody wants a machine quietly appending stoppages to a Master's statement of
// facts the moment a document lands. The operator asks, sees what would be
// suggested, and only then applies.
const RunSchema = z.object({
  // Default false: preview first. Writing is an explicit second decision.
  apply: z.boolean().default(false),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const parsed = RunSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await runWwdResolver(claimId, supabase, {
      apply: parsed.data.apply,
      createdBy: auth.userId,
    });

    return NextResponse.json(result);
  } catch (e) {
    return apiError(e, "wwd-resolve/POST", {
      WWD_EVENT_INSERT_FAILED: 503,
      WWD_DOCUMENT_FAILED: 503,
    });
  }
}
