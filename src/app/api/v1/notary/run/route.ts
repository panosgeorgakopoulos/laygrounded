import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { sweepNotary } from "@/lib/legal/notary-server";
import { anchorProvider } from "@/lib/legal/anchor";

const RunSchema = z.object({
  // Skip anchoring for this run (e.g. a catch-up pass you don't want to spend
  // TSA requests on). The proofs are still written; they are simply not
  // independently timestamped, and each row records that.
  anchor: z.boolean().default(true),
});

// Hourly Merkle notarization sweep. Two callers (same contract as run-sync):
//   * an external scheduler with the CRON_SECRET header — whole book, service
//     role;
//   * an authenticated user — their own company only.
//
// Schedule it hourly. A proof is written only when a claim's root actually
// CHANGED since its last proof, so an unchanged hour costs one hash and no
// row: if the root is unchanged the record is unchanged, and the previous
// proof already covers every instant since. Re-runs are therefore safe and
// overlapping runs cannot spam the ledger.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await sweepNotary({ client: service });
    return NextResponse.json({ mode: "cron", anchorProvider: anchorProvider(), report });
  }

  try {
    const auth = await requireAuth();
    const parsed = RunSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Service client for the write path, but scoped to the caller's company —
    // same ownership-pinning as the other sweeps.
    const service = createServiceRoleClient();
    const report = await sweepNotary({
      client: service,
      companyId: auth.companyId,
      anchor: parsed.data.anchor,
    });

    return NextResponse.json({ mode: "user", anchorProvider: anchorProvider(), report });
  } catch (e) {
    return apiError(e, "v1/notary/run/POST");
  }
}
