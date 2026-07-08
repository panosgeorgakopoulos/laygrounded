import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { uploadSofAndExtract } from "@/lib/ai/extraction";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "NO_FILE" }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fname = `${Date.now()}-${safeName}`;
    const storagePath = `${auth.companyId}/${claimId}/${fname}`;
    const mime = file.type || "application/octet-stream";

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadErr } = await supabase.storage
      .from("sofs")
      .upload(storagePath, arrayBuffer, {
        contentType: mime,
      });

    if (uploadErr) {
      throw new Error(`Upload failed: ${uploadErr.message}`);
    }

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({
        claim_id: claimId,
        storage_path: storagePath,
        mime: mime,
        extraction_status: "extracting",
        page_count: 1, 
      })
      .select()
      .single();

    if (docErr || !doc) {
      throw new Error("Failed to insert document record");
    }

    uploadSofAndExtract({
      storagePath,
      mime,
      pageCount: 1,
      claimId,
      documentId: doc.id,
    }).catch((e) => {
      console.error("Extraction failed:", e);
    });

    const { data: signedUrlData } = await supabase.storage
      .from("sofs")
      .createSignedUrl(storagePath, 3600);

    return NextResponse.json({
      document: {
        id: doc.id,
        storagePath,
        url: signedUrlData?.signedUrl || null,
        mime,
        originalFilename: file.name,
        extractionStatus: doc.extraction_status,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
