import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";

const UpdateCompanySchema = z.object({
  name: z.string().min(1),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .select("id, name, created_at")
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
          role: m.role,
          createdAt: user?.created_at || company.created_at,
        };
      })
    );

    return NextResponse.json({
      company: {
        id: company.id,
        name: company.name,
        createdAt: company.created_at,
      },
      members,
    });
  } catch (e) {
    const isAuth = e instanceof Error && e.message === "UNAUTHORIZED";
    return NextResponse.json({ error: (e as Error).message }, { status: isAuth ? 401 : 500 });
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

    const { data: updated, error } = await supabase
      .from("companies")
      .update({ name: parsed.data.name })
      .eq("id", auth.companyId)
      .select()
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json({
      company: {
        id: updated.id,
        name: updated.name,
        createdAt: updated.created_at,
      }
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
