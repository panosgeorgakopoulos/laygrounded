import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-errors";
import { DEFAULT_SHARE_EXPIRY_DAYS, generateShareToken, shareAccessMode } from "@/lib/rooms";
import { requireOwnedClaim } from "@/lib/audit/claim-access";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

const CreateShareSchema = z.object({
  counterpartyLabel: z.string().max(120).default(""),
  expiresInDays: z.number().int().min(1).max(365).default(DEFAULT_SHARE_EXPIRY_DAYS),
  // Defaults to the negotiation room, matching the column default and every
  // caller that predates Phase 17. A read-only statement is opted into.
  accessMode: z.enum(["negotiate", "readonly"]).default("negotiate"),
});

const RevokeShareSchema = z.object({
  shareId: z.string().uuid(),
});

function serialize(share: any) {
  const mode = shareAccessMode(share.access_mode);
  return {
    id: share.id,
    token: share.token,
    accessMode: mode,
    // The path depends on what the token GRANTS, resolved in one place. A UI
    // that built this itself would eventually offer a readonly token at
    // /rooms/, where it 404s — a link the owner has already emailed.
    roomPath: mode === "readonly" ? `/share/claim/${share.token}` : `/rooms/${share.token}`,
    counterpartyLabel: share.counterparty_label,
    expiresAt: share.expires_at,
    revokedAt: share.revoked_at,
    createdAt: share.created_at,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { supabase } = await requireOwnedClaim(claimId, "id, company_id", req);

    const { data: shares } = await supabase
      .from("claim_shares")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });

    return NextResponse.json({ shares: (shares || []).map(serialize) });
  } catch (e) {
    return apiError(e, "share/GET");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { auth, supabase } = await requireOwnedClaim(claimId, "id, company_id", req);

    const body = await req.json().catch(() => ({}));
    const parsed = CreateShareSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const expiresAt = new Date(
      Date.now() + parsed.data.expiresInDays * 24 * 3600_000
    ).toISOString();

    const { data: share, error } = await supabase
      .from("claim_shares")
      .insert({
        claim_id: claimId,
        token: generateShareToken(),
        counterparty_label: parsed.data.counterpartyLabel,
        created_by: auth.userId,
        expires_at: expiresAt,
        access_mode: parsed.data.accessMode,
      })
      .select("*")
      .single();

    if (error || !share) throw new Error(`PERSIST_FAILED: ${error?.message}`);

    // Granting an outsider access to a claim is the single act on this
    // surface most likely to be questioned later. The token is deliberately
    // NOT recorded: it is the credential itself, and an audit row that half
    // the company can read is no place for it.
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "share.created",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "claim",
      resourceId: claimId,
      metadata: {
        shareId: share.id,
        counterpartyLabel: parsed.data.counterpartyLabel,
        expiresAt,
        // WHICH KIND of access was granted. "We shared this claim" is a much
        // weaker audit record than "we granted a party the ability to file
        // proposals against it" — those are different acts.
        accessMode: parsed.data.accessMode,
      },
      ...requestAttribution(req),
    });

    return NextResponse.json({ share: serialize(share) }, { status: 201 });
  } catch (e) {
    return apiError(e, "share/POST");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { auth, supabase } = await requireOwnedClaim(claimId, "id, company_id", req);

    const body = await req.json().catch(() => ({}));
    const parsed = RevokeShareSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { data: share, error } = await supabase
      .from("claim_shares")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", parsed.data.shareId)
      .eq("claim_id", claimId)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!share) {
      return NextResponse.json({ error: "SHARE_NOT_FOUND" }, { status: 404 });
    }

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "share.revoked",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "claim",
      resourceId: claimId,
      metadata: { shareId: share.id, counterpartyLabel: share.counterparty_label },
      ...requestAttribution(req),
    });

    return NextResponse.json({ share: serialize(share) });
  } catch (e) {
    return apiError(e, "share/DELETE", { SHARE_NOT_FOUND: 404 });
  }
}
