// LayGrounded auth + bootstrap helpers.
// Uses NextAuth credentials provider with bcrypt-hashed passwords stored in Prisma.
// On first sign-in or sign-up, auto-bootstraps a company membership for the user.

import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

// Auto-bootstrap: creates a company if user has no membership, inserts as admin.
// Equivalent to spec's bootstrap_user_company(user_id, company_name) Postgres function.
export async function bootstrapUserCompany(
  userId: string,
  userEmail: string,
  companyName?: string
): Promise<{ companyId: string; companyName: string }> {
  const existing = await db.companyMember.findFirst({
    where: { userId },
    include: { company: true },
  });
  if (existing) {
    return { companyId: existing.companyId, companyName: existing.company.name };
  }

  const name = companyName?.trim() || `${userEmail.split("@")[0]}'s Fleet`;
  const company = await db.company.create({
    data: {
      id: uuid(),
      name,
      members: {
        create: {
          id: uuid(),
          userId,
          email: userEmail,
          role: "admin",
        },
      },
    },
  });
  return { companyId: company.id, companyName: company.name };
}

// Create a new user with hashed password.
export async function createUser(email: string, password: string, name?: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.user.create({
    data: {
      id: uuid(),
      email: email.toLowerCase().trim(),
      name: name?.trim() || null,
      passwordHash,
    },
  });
  return user;
}

// Verify password against stored hash.
export async function verifyPassword(
  password: string,
  hash: string | null
): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

// Get or create a demo user for the SEED_DEMO flow.
export async function ensureDemoUser() {
  const email = "demo@laygrounded.io";
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    const passwordHash = await bcrypt.hash("demo1234", 10);
    user = await db.user.create({
      data: {
        id: uuid(),
        email,
        name: "Demo Captain",
        passwordHash,
      },
    });
  }
  await bootstrapUserCompany(user.id, user.email, "LayGrounded Demo Fleet");
  return user;
}
