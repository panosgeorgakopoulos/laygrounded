import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

const CreateIntegrationSchema = z.object({
  provider: z.enum(["VESON_IMOS", "MOCK_ERP"]),
  displayName: z.string().max(120).default(""),
  baseUrl: z.string().url().or(z.literal("")).default(""),
  apiToken: z.string().max(4096).optional(),
});

// Auth material never leaves the server; expose only whether it's configured.
function serialize(row: any) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    baseUrl: row.base_url,
    status: row.status,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    hasApiToken: !!row.auth?.api_token,
    // The one-time exception: the webhook secret is returned on creation so
    // the user can configure the ERP side; afterwards only its presence.
    hasWebhookSecret: !!row.auth?.webhook_secret,
    webhookPath: `/api/integrations/${row.id}/webhook`,
  };
}

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const { data } = await supabase
      .from("integrations")
      .select("*")
      .eq("company_id", auth.companyId)
      .order("created_at", { ascending: false });
    return NextResponse.json({ integrations: (data ?? []).map(serialize) });
  } catch (e) {
    return apiError(e, "integrations/GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const parsed = CreateIntegrationSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const webhookSecret = randomBytes(24).toString("hex");
    const { data, error } = await supabase
      .from("integrations")
      .insert({
        company_id: auth.companyId,
        provider: parsed.data.provider,
        display_name: parsed.data.displayName,
        base_url: parsed.data.baseUrl,
        auth: {
          ...(parsed.data.apiToken ? { api_token: parsed.data.apiToken } : {}),
          webhook_secret: webhookSecret,
        },
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(`PERSIST_FAILED: ${error?.message}`);

    return NextResponse.json(
      {
        integration: serialize(data),
        // Shown exactly once — configure it as the HMAC secret on the ERP side.
        webhookSecret,
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "integrations/POST");
  }
}
