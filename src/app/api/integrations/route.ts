import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/integrations/registry";

const CreateIntegrationSchema = z.object({
  // Driven off the registry so the enum cannot drift from the adapters that
  // exist. The database CHECK constraint is the third copy of this list and
  // the one `tsc` cannot see — see the note in registry.ts.
  provider: z.enum(PROVIDER_IDS),
  displayName: z.string().max(120).default(""),
  baseUrl: z.string().url().or(z.literal("")).default(""),
  apiToken: z.string().max(4096).optional(),
  // Danaos-style SOAP tenants authenticate the envelope, not the transport.
  username: z.string().max(200).optional(),
  password: z.string().max(1024).optional(),
  // "mock" serves deterministic fixtures instead of calling the ERP. Opt-in
  // only, and refused in production without ALLOW_MOCK_ERP_IN_PRODUCTION=1.
  mode: z.enum(["live", "mock"]).optional(),
});

// Auth material never leaves the server; expose only whether it's configured.
function serialize(row: any) {
  const descriptor = PROVIDERS.find((p) => p.provider === row.provider);
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: descriptor?.label ?? row.provider,
    transport: descriptor?.transport ?? null,
    // Surfaced so an operator can tell a documented mapping from one written
    // against a product family's general shape. Veson is documented; Danaos,
    // Fortune and Ulysses are not, and hiding that would be the dishonest part.
    mappingVerifiedAgainstVendorDocs: descriptor?.mappingVerifiedAgainstVendorDocs ?? false,
    // Provenance, carried to the UI exactly as the market adapters do.
    mode: row.config?.mode === "mock" ? "mock" : "live",
    displayName: row.display_name,
    baseUrl: row.base_url,
    status: row.status,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    hasApiToken: !!row.auth?.api_token,
    hasUsername: !!row.auth?.username,
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
          ...(parsed.data.username ? { username: parsed.data.username } : {}),
          ...(parsed.data.password ? { password: parsed.data.password } : {}),
          webhook_secret: webhookSecret,
        },
        config: parsed.data.mode ? { mode: parsed.data.mode } : {},
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
