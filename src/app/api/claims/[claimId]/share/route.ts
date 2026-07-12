import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { DEFAULT_SHARE_EXPIRY_DAYS, generateShareToken } from "@/lib/rooms";

const CreateShareSchema = z.object({
  counterpartyLabel: z.string().max(120).default(""),
  expiresInDays: z.number().int().min(1).max(365).default(DEFAULT_SHARE_EXPIRY_DAYS),
});

const RevokeShareSchema = z.object({
  shareId: z.string().uuid(),
});

function serialize(share: any) {
  return {
    id: share.id,
    token: share.token,
    roomPath: `/rooms/${share.token}`,
    counterpartyLabel: share.counterparty_label,
    expiresAt: share.expires_at,
    revokedAt: share.revoked_at,
    createdAt: share.created_at,
  };
}

async function requireOwnedClaim(claimId: string) {
  const auth = await requireAuth();
  const supabase = await createClient();
  const { data: claim } = await supabase
    .from("claims")
    .select("company_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim || claim.company_id !== auth.companyId) {
    throw new Error("CLAIM_NOT_FOUND");
  }
  return { auth, supabase };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { supabase } = await requireOwnedClaim(claimId);

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
    const { auth, supabase } = await requireOwnedClaim(claimId);

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
      })
      .select("*")
      .single();

    if (error || !share) throw new Error(`PERSIST_FAILED: ${error?.message}`);

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
    const { supabase } = await requireOwnedClaim(claimId);

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

    return NextResponse.json({ share: serialize(share) });
  } catch (e) {
    return apiError(e, "share/DELETE", { SHARE_NOT_FOUND: 404 });
  }
}
