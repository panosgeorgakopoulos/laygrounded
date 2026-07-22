import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { API_SCOPES, generateApiKey } from "@/lib/api/keys";

// Key management is SESSION-authenticated, not key-authenticated: you cannot
// bootstrap the first key with a key, and a leaked integration key must not be
// able to mint itself more keys or widen its own scope. Issuing credentials is
// an operator action performed by a logged-in human.

const CreateSchema = z.object({
  label: z.string().min(1).max(120),
  // No default: granting scopes must be a deliberate act, not an omission.
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(120),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const key = generateApiKey();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        company_id: auth.companyId,
        label: parsed.data.label,
        key_hash: key.hash,
        key_prefix: key.prefix,
        scopes: parsed.data.scopes,
        rate_limit_per_minute: parsed.data.rateLimitPerMinute,
        expires_at: parsed.data.expiresAt ?? null,
        created_by: auth.userId,
      })
      .select("id, label, key_prefix, scopes, rate_limit_per_minute, expires_at, created_at")
      .single();
    if (error || !data) throw new Error(`KEY_CREATE_FAILED: ${error?.message}`);

    return NextResponse.json(
      {
        id: data.id,
        label: data.label,
        keyPrefix: data.key_prefix,
        scopes: data.scopes,
        rateLimitPerMinute: data.rate_limit_per_minute,
        expiresAt: data.expires_at,
        createdAt: data.created_at,
        // Once. Only the hash is stored, so this cannot be shown again.
        apiKey: key.plaintext,
        apiKeyNotice:
          "Copy this key now — only its hash is stored and it cannot be shown again. Send it as: Authorization: Bearer <key>. If lost, revoke it and issue another.",
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "v1/audit/keys/POST");
  }
}

// Lists keys by prefix and metadata — never anything that could reconstruct one.
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, label, key_prefix, scopes, status, rate_limit_per_minute, last_used_at, expires_at, created_at, revoked_at")
      .eq("company_id", auth.companyId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`QUERY_FAILED: ${error.message}`);

    return NextResponse.json({
      keys: (data ?? []).map((k) => ({
        id: k.id,
        label: k.label,
        keyPrefix: k.key_prefix,
        scopes: k.scopes,
        status: k.status,
        rateLimitPerMinute: k.rate_limit_per_minute,
        lastUsedAt: k.last_used_at,
        expiresAt: k.expires_at,
        createdAt: k.created_at,
        revokedAt: k.revoked_at,
      })),
    });
  } catch (e) {
    return apiError(e, "v1/audit/keys/GET", { QUERY_FAILED: 503 });
  }
}
