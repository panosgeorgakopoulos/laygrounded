import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { bootstrapUserCompany } from "@/lib/auth-helpers";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { name, companyName } = await req.json();

  try {
    const result = await bootstrapUserCompany(user.id, user.email!, companyName || name);
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
