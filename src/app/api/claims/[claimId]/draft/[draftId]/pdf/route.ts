import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  prepareGroundedLetter,
  DraftNotGroundedError,
  groundingFailureBody,
} from "@/lib/drafting/publish-server";

// Renders a grounded draft to a formal PDF and returns a signed URL.
//
// Grounding is re-verified against the live claim before anything is
// rendered (see publish-server.ts): a letter whose figures have drifted since
// it was drafted is refused with the specific violations, never printed on
// letterhead. This is the enforcement point — the UI badge is a courtesy, the
// gate is here.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string; draftId: string }> }
) {
  try {
    const { claimId, draftId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const prepared = await prepareGroundedLetter({
      claimId,
      draftId,
      companyId: auth.companyId,
      client: supabase,
    });

    // Stored beside the claim pack exports, under the tenant's prefix.
    const path = `${auth.companyId}/letters/${claimId}/${draftId}-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from("sofs")
      .upload(path, prepared.pdfBytes, { contentType: "application/pdf" });
    if (upErr) throw new Error(`PERSIST_FAILED: ${upErr.message}`);

    const { data: signed } = await supabase.storage.from("sofs").createSignedUrl(path, 3600);

    return NextResponse.json({
      url: signed?.signedUrl ?? null,
      path,
      filename: prepared.filename,
      grounding: {
        verified: prepared.grounding.verified,
        amountsChecked: prepared.grounding.amountsChecked,
        clausesChecked: prepared.grounding.clausesChecked,
      },
    });
  } catch (e) {
    if (e instanceof DraftNotGroundedError) {
      return NextResponse.json(groundingFailureBody(e), { status: 422 });
    }
    return apiError(e, "claims/draft/pdf/POST", {
      DRAFT_NOT_FOUND: 404,
      NO_CALCULATION: 409,
    });
  }
}
