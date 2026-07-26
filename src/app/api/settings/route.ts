import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

// Both fields optional so a caller can change either independently — a company
// withdrawing from market aggregates must not have to resubmit its name, and a
// rename must never silently re-enrol it.
const UpdateCompanySchema = z
  .object({
    name: z.string().min(1).optional(),
    shareMarketData: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.shareMarketData !== undefined, {
    message: "Nothing to update",
  });

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .select("id, name, created_at, share_market_data")
      .eq("id", auth.companyId)
      .maybeSingle();

    if (companyErr || !company) {
      return NextResponse.json({ error: "COMPANY_NOT_FOUND" }, { status: 404 });
    }

    const { data: membersData } = await supabase
      .from("company_members")
      .select("user_id, role")
      .eq("company_id", auth.companyId);

    const adminClient = createServiceRoleClient();
    const members = await Promise.all(
      (membersData || []).map(async (m) => {
        const { data: userData } = await adminClient.auth.admin.getUserById(m.user_id);
        const user = userData?.user;
        return {
          id: m.user_id,
          email: user?.email || "Unknown",
          displayName: user?.user_metadata?.display_name || null,
          role: m.role,
          createdAt: user?.created_at || company.created_at,
        };
      })
    );

    return NextResponse.json({
      company: {
        id: company.id,
        name: company.name,
        // Contractual: the terms give the client a right to withdraw from market
        // aggregates "within their account settings", so this has to be both
        // readable and writable here, not just a column an operator can flip.
        shareMarketData: company.share_market_data ?? true,
        createdAt: company.created_at,
      },
      members,
    });
  } catch (e) {
    return apiError(e, "settings/GET");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: membership } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", auth.companyId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = UpdateCompanySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.shareMarketData !== undefined) {
      patch.share_market_data = parsed.data.shareMarketData;
    }

    const { data: updated, error } = await supabase
      .from("companies")
      .update(patch)
      .eq("id", auth.companyId)
      .select()
      .maybeSingle();

    if (error) throw error;
    // RLS returns zero rows rather than an error when it denies the write. Left
    // unguarded this dereferenced null and surfaced as an opaque 500 — which is
    // exactly how a missing UPDATE policy on `companies` hid a permanently
    // broken rename for so long.
    if (!updated) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    return NextResponse.json({
      company: {
        id: updated.id,
        name: updated.name,
        shareMarketData: updated.share_market_data,
        createdAt: updated.created_at,
      }
    });
  } catch (e) {
    return apiError(e, "settings/PATCH");
  }
}
