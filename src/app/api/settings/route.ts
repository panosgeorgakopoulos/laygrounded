// GET /api/settings — fetch company + members.
// PATCH /api/settings — update company name.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";

const UpdateCompanySchema = z.object({
  name: z.string().min(1),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const company = await db.company.findUnique({
      where: { id: auth.companyId },
      include: { members: { orderBy: { createdAt: "asc" } } },
    });
    if (!company) {
      return NextResponse.json({ error: "COMPANY_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({
      company: {
        id: company.id,
        name: company.name,
        createdAt: company.createdAt,
      },
      members: company.members.map((m) => ({
        id: m.id,
        email: m.email,
        role: m.role,
        createdAt: m.createdAt,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth();
    // Only admin can rename company.
    const membership = await db.companyMember.findUnique({
      where: {
        companyId_userId: { companyId: auth.companyId, userId: auth.userId },
      },
    });
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
    const updated = await db.company.update({
      where: { id: auth.companyId },
      data: { name: parsed.data.name },
    });
    return NextResponse.json({ company: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
