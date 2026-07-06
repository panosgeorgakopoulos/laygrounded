// POST /api/claims/[claimId]/documents — upload a new document.
// Inserts documents row with extraction_status='pending', triggers AI extraction.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { uploadSofAndExtract } from "@/lib/ai/extraction";
import { promises as fs } from "fs";
import path from "path";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
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

    // Save file to public/uploads/{companyId}/{claimId}/{filename}
    const dir = path.join(UPLOAD_ROOT, auth.companyId, claimId);
    await fs.mkdir(dir, { recursive: true });
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fname = `${Date.now()}-${safeName}`;
    const fpath = path.join(dir, fname);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(fpath, buf);

    const storagePath = `${auth.companyId}/${claimId}/${fname}`;
    const mime = file.type || "application/octet-stream";

    // Insert documents row.
    const doc = await db.document.create({
      data: {
        claimId,
        storagePath,
        originalFilename: file.name,
        mime,
        extractionStatus: "extracting",
        pageCount: mime === "application/pdf" ? 1 : 1, // PDF page count detected during extraction
      },
    });

    // Trigger extraction async (do not await — return immediately).
    uploadSofAndExtract({
      storagePath: fpath,
      mime,
      pageCount: 1,
      claimId,
      documentId: doc.id,
    }).catch((e) => {
      console.error("Extraction failed:", e);
    });

    return NextResponse.json({
      document: {
        id: doc.id,
        storagePath,
        url: `/uploads/${storagePath}`,
        mime,
        originalFilename: file.name,
        extractionStatus: doc.extractionStatus,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
