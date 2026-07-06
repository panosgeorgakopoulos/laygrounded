// GET /api/claims/[claimId]/documents/[docId] — get document (signed URL equivalent).
// DELETE — replace document (sets all child sof_events to status='rejected' with ai_reasoning,
//          then re-extracts).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { uploadSofAndExtract } from "@/lib/ai/extraction";
import path from "path";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string; docId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, docId } = await params;
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const doc = await db.document.findUnique({ where: { id: docId } });
    if (!doc || doc.claimId !== claimId) {
      return NextResponse.json({ error: "DOC_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({
      document: {
        ...doc,
        url: `/uploads/${doc.storagePath}`,
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
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    // Mark all child events as rejected.
    await db.sofEvent.updateMany({
      where: { documentId: docId },
      data: {
        status: "rejected",
        aiReasoning: "superseded by document replacement",
      },
    });
    // Re-extract from this document.
    const doc = await db.document.findUnique({ where: { id: docId } });
    if (doc) {
      await db.document.update({
        where: { id: docId },
        data: { extractionStatus: "extracting" },
      });
      const fpath = path.join(process.cwd(), "public", "uploads", doc.storagePath);
      uploadSofAndExtract({
        storagePath: fpath,
        mime: doc.mime,
        pageCount: doc.pageCount ?? 1,
        claimId,
        documentId: doc.id,
      }).catch((e) => console.error("Re-extract failed:", e));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
