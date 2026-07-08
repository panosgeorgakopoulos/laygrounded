import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { uploadSofAndExtract } from "@/lib/ai/extraction";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string; docId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, docId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase.from("claims").select("company_id").eq("id", claimId).single();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    
    const { data: doc } = await supabase.from("documents").select("*").eq("id", docId).single();
    if (!doc || doc.claim_id !== claimId) {
      return NextResponse.json({ error: "DOC_NOT_FOUND" }, { status: 404 });
    }

    const { data: signedUrlData } = await supabase.storage
      .from("sofs")
      .createSignedUrl(doc.storage_path, 3600);

    return NextResponse.json({
      document: {
        ...doc,
        url: signedUrlData?.signedUrl || null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; docId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, docId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase.from("claims").select("company_id").eq("id", claimId).single();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    await supabase.from("sof_events").update({
      status: "rejected",
      ai_reasoning: "superseded by document replacement",
    }).eq("document_id", docId);

    const { data: doc } = await supabase.from("documents").select("*").eq("id", docId).single();
    if (doc) {
      await supabase.from("documents").update({ extraction_status: "extracting" }).eq("id", docId);
      
      uploadSofAndExtract({
        storagePath: doc.storage_path,
        mime: doc.mime,
        pageCount: doc.page_count ?? 1,
        claimId,
        documentId: doc.id,
      }).catch((e) => console.error("Re-extract failed:", e));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
