// Server-side helpers to retrieve the authenticated user + their company.
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export interface AuthContext {
  userId: string;
  email: string;
  companyId: string;
  companyName: string;
}

// Equivalent to spec's requireSupabaseAuth — enforces auth + company membership.
export async function requireAuth(): Promise<AuthContext> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    throw new Error("UNAUTHORIZED");
  }
  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    throw new Error("UNAUTHORIZED");
  }
  const membership = await db.companyMember.findFirst({
    where: { userId },
    include: { company: true },
  });
  if (!membership) {
    throw new Error("NO_COMPANY");
  }
  return {
    userId,
    email: session.user.email,
    companyId: membership.companyId,
    companyName: membership.company.name,
  };
}
