import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

const UpdateIntegrationSchema = z.object({
  displayName: z.string().max(120).optional(),
  baseUrl: z.string().url().or(z.literal("")).optional(),
  apiToken: z.string().max(4096).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { integrationId } = await params;
    const supabase = await createClient();

    const { data: existing } = await supabase
      .from("integrations")
      .select("*")
      .eq("id", integrationId)
      .eq("company_id", auth.companyId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "INTEGRATION_NOT_FOUND" }, { status: 404 });
    }

    const parsed = UpdateIntegrationSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const patch: any = { updated_at: new Date().toISOString() };
    if (parsed.data.displayName !== undefined) patch.display_name = parsed.data.displayName;
    if (parsed.data.baseUrl !== undefined) patch.base_url = parsed.data.baseUrl;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.apiToken !== undefined) {
      patch.auth = { ...existing.auth, api_token: parsed.data.apiToken };
    }

    const { error } = await supabase.from("integrations").update(patch).eq("id", integrationId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, "integrations/PATCH", { INTEGRATION_NOT_FOUND: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { integrationId } = await params;
    const supabase = await createClient();

    const { data } = await supabase
      .from("integrations")
      .delete()
      .eq("id", integrationId)
      .eq("company_id", auth.companyId)
      .select("id")
      .maybeSingle();
    if (!data) {
      return NextResponse.json({ error: "INTEGRATION_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, "integrations/DELETE", { INTEGRATION_NOT_FOUND: 404 });
  }
}
