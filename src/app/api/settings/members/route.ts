import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const body = await req.json();
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { data: membership } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", auth.companyId)
      .eq("user_id", auth.userId)
      .single();

    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const email = parsed.data.email.toLowerCase().trim();
    const adminClient = createServiceRoleClient();

    // Look for existing user
    const { data: userId } = await adminClient.rpc("get_user_id_by_email", { email_addr: email });

    if (userId) {
      const { data: existing } = await supabase
        .from("company_members")
        .select("*")
        .eq("company_id", auth.companyId)
        .eq("user_id", userId)
        .single();

      if (existing) {
        return NextResponse.json({ error: "ALREADY_MEMBER" }, { status: 409 });
      }

      await supabase.from("company_members").insert({
        company_id: auth.companyId,
        user_id: userId,
        role: parsed.data.role,
      });

      return NextResponse.json({ 
        member: { id: userId, email, role: parsed.data.role } 
      });
    }

    // User does not exist, invite them
    const { data: invitedUser, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email);
    
    if (inviteErr || !invitedUser?.user) {
      return NextResponse.json({ error: inviteErr?.message || "Failed to invite user" }, { status: 500 });
    }

    await supabase.from("company_members").insert({
      company_id: auth.companyId,
      user_id: invitedUser.user.id,
      role: parsed.data.role,
    });

    return NextResponse.json({ 
      member: { id: invitedUser.user.id, email, role: parsed.data.role }, 
      pending: true 
    });
  } catch (e) {
    const isAuth = e instanceof Error && e.message === "UNAUTHORIZED";
    return NextResponse.json({ error: (e as Error).message }, { status: isAuth ? 401 : 500 });
  }
}
