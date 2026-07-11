import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { uploadSofAndExtract } from "@/lib/ai/extraction";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string; docId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, docId } = await params;
    const supabase = await createClient();
    
    const { data: claim } = await supabase.from("claims").select("company_id").eq("id", claimId).maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    
    const { data: doc } = await supabase.from("documents").select("*").eq("id", docId).maybeSingle();
    if (!doc || doc.claim_id !== claimId) {
      return NextResponse.json({ error: "DOC_NOT_FOUND" }, { status: 404 });
    }

    const { data: signedUrlData } = await supabase.storage
      .from("sofs")
      .createSignedUrl(doc.storage_path, 300);

    return NextResponse.json({
      document: {
        ...doc,
        url: signedUrlData?.signedUrl || null,
      },
    });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; docId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, docId } = await params;
    const supabase = await createClient();
    
    const { data: claim } = await supabase.from("claims").select("company_id").eq("id", claimId).maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const { data: doc } = await supabase.from("documents").select("*").eq("id", docId).maybeSingle();
    if (!doc || doc.claim_id !== claimId) {
      return NextResponse.json({ error: "DOC_NOT_FOUND" }, { status: 404 });
    }

    // Delete the file from storage
    if (doc.storage_path) {
      await supabase.storage.from("sofs").remove([doc.storage_path]);
    }

    // Delete the document record (cascades or cleans up sof_events if FK is set, or we explicitly delete them)
    await supabase.from("sof_events").delete().eq("document_id", docId);
    await supabase.from("documents").delete().eq("id", docId);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
