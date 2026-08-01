// Deterministic SoF text ingestion for the workspace.
//
// The session-authenticated twin of `/api/v1/ingestion/sof-text`, which is
// API-key only and therefore unreachable from the app. Same extractor, same
// write path (`sof-text-server.ts`), different door.
//
// WHY THIS EXISTS ALONGSIDE THE VISION PIPELINE. `/api/claims/[id]/documents`
// sends page images to a model and is the high-fidelity route for a scanned
// SoF. This one is line-based, deterministic and free: no model call, instant,
// and the same text always yields the same events. That makes it the right tool
// for a forwarded email body or a PDF's text layer, and it is reproducible in a
// way an LLM extraction is not — which matters when the output ends up in a
// figure someone disputes.
//
// TWO STEPS ON PURPOSE. A preview returns candidates without writing anything;
// only an explicit commit persists them. Unstructured text can yield nonsense,
// and writing thirty junk events into a claim so the user can reject them one
// by one is worse than showing them first. Committed events land as
// `suggested`, so they still face the normal review queue.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { extractSofTimeline } from "@/lib/ingestion/multimodal";
import {
  ensureMultimodalDocument,
  persistSuggestedSofEvents,
} from "@/lib/ingestion/sof-text-server";

const BodySchema = z.object({
  text: z.string().min(20).max(50_000),
  /**
   * The port's UTC offset, for SoFs whose lines carry naive local times.
   * Without it those lines are REPORTED as warnings, never guessed — a laytime
   * figure computed from a timestamp whose zone was assumed is a wrong figure
   * that looks right.
   */
  defaultUtcOffset: z
    .string()
    .regex(/^(?:Z|[+-]\d{2}:?\d{2})$/, "Expected Z or ±HH:MM")
    .optional(),
  /** False (the default) previews without writing. */
  commit: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    // Defense in depth alongside RLS, as every claim-scoped route does.
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { text, defaultUtcOffset, commit } = parsed.data;

    const extraction = extractSofTimeline(text, { defaultUtcOffset });

    if (extraction.events.length === 0) {
      // 422, not 500: the text was read fine, it simply had no datable events.
      // The warnings say why, and are the actionable part — usually a missing
      // timezone the user can supply and retry.
      return NextResponse.json(
        {
          error: "SOF_UNPARSEABLE",
          warnings: extraction.warnings,
          matchedLines: extraction.matchedLines,
          totalLines: extraction.totalLines,
        },
        { status: 422 }
      );
    }

    if (!commit) {
      return NextResponse.json({
        committed: false,
        events: extraction.events,
        warnings: extraction.warnings,
        matchedLines: extraction.matchedLines,
        totalLines: extraction.totalLines,
      });
    }

    const documentId = await ensureMultimodalDocument(supabase, claimId);
    const inserted = await persistSuggestedSofEvents(
      supabase,
      claimId,
      documentId,
      extraction.events
    );

    return NextResponse.json({
      committed: true,
      inserted: inserted.length,
      warnings: extraction.warnings,
      // Nothing is recomputed here, and that is the point: `suggested` events
      // are invisible to the engine until someone accepts them.
      note: "Events added as suggestions. They do not affect any figure until confirmed in the timeline.",
    });
  } catch (e) {
    return apiError(e, "claims/ingest-sof-text/POST", { SOF_UNPARSEABLE: 422 });
  }
}
