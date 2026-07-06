// POST /api/settings/members — invite a member by email.
// Inserts pending company_members row.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const body = await req.json();
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    // Only admin can invite.
    const membership = await db.companyMember.findUnique({
      where: {
        companyId_userId: { companyId: auth.companyId, userId: auth.userId },
      },
    });
    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    // Look for existing user with that email; if found, add as member immediately.
    const user = await db.user.findUnique({
      where: { email: parsed.data.email.toLowerCase().trim() },
    });
    if (user) {
      // Skip if already a member.
      const existing = await db.companyMember.findUnique({
        where: {
          companyId_userId: { companyId: auth.companyId, userId: user.id },
        },
      });
      if (existing) {
        return NextResponse.json({ error: "ALREADY_MEMBER" }, { status: 409 });
      }
      const member = await db.companyMember.create({
        data: {
          companyId: auth.companyId,
          userId: user.id,
          email: user.email,
          role: parsed.data.role,
        },
      });
      return NextResponse.json({ member });
    }
    // User does not exist yet — insert pending row with placeholder userId.
    // In production, would send an email invite.
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const member = await db.companyMember.create({
      data: {
        companyId: auth.companyId,
        userId: pendingId,
        email: parsed.data.email.toLowerCase().trim(),
        role: parsed.data.role,
      },
    });
    return NextResponse.json({ member, pending: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
