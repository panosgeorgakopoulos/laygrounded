import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  prepareGroundedLetter,
  DraftNotGroundedError,
  groundingFailureBody,
} from "@/lib/drafting/publish-server";
import { deliverDemandLetter, isValidRecipient } from "@/lib/drafting/delivery";

const SendSchema = z.object({
  to: z.string().min(3).max(254),
  // Explicit, per-request intent. Sending a demand letter is an outward-facing
  // legal act against a real counterparty: it must never be the accidental
  // consequence of a mis-click or a replayed request, so the caller has to say
  // so in the body every time. No default.
  confirm: z.literal(true),
});

// Emails a grounded demand letter to the counterparty, with the PDF attached.
//
// Two gates, in order: the letter must still be grounded against the live
// claim, and the caller must explicitly confirm. Only then is delivery
// attempted — and with no provider configured, delivery honestly reports that
// nothing was sent rather than simulating a success (see delivery.ts).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; draftId: string }> }
) {
  try {
    const { claimId, draftId } = await params;
    const auth = await requireAuth();

    const parsed = SendSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    if (!isValidRecipient(parsed.data.to)) {
      return NextResponse.json({ error: "INVALID_RECIPIENT" }, { status: 400 });
    }

    const supabase = await createClient();
    const prepared = await prepareGroundedLetter({
      claimId,
      draftId,
      companyId: auth.companyId,
      client: supabase,
    });

    const outcome = await deliverDemandLetter({
      to: parsed.data.to.trim(),
      subject: prepared.draft.subject,
      bodyText: prepared.draft.content_md,
      pdf: { filename: prepared.filename, bytes: prepared.pdfBytes },
    });

    if (!outcome.sent) {
      // 503, not 500: the letter is valid and the request was well-formed —
      // the delivery channel simply isn't there. The operator's next step is
      // to download the PDF, so say that plainly.
      return NextResponse.json(
        { error: "DELIVERY_UNAVAILABLE", reason: outcome.reason, message: outcome.detail },
        { status: 503 }
      );
    }

    return NextResponse.json({
      sent: true,
      to: outcome.to,
      provider: outcome.provider,
      messageId: outcome.messageId,
    });
  } catch (e) {
    if (e instanceof DraftNotGroundedError) {
      return NextResponse.json(groundingFailureBody(e), { status: 422 });
    }
    return apiError(e, "claims/draft/send/POST", {
      DRAFT_NOT_FOUND: 404,
      NO_CALCULATION: 409,
      INVALID_RECIPIENT: 400,
    });
  }
}
