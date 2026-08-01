// Escrow deployments, per chain.
//
// An escrow contract is a deployment on ONE chain: the same address elsewhere is
// a different contract, usually nothing at all. So these are keyed on chain id,
// and `escrow-server.ts` looks up the one matching the chain both settlement
// parties are configured on.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import {
  InvalidFinanceDetailsError,
  deleteSettlementChainConfig,
  listSettlementChainConfigs,
  upsertSettlementChainConfig,
} from "@/lib/settlement/counterparty-finance-server";

const UpsertSchema = z.object({
  chainId: z.number().int().positive(),
  verifyingContract: z.string().max(64),
  tokenAddress: z.string().max(64).nullable().optional(),
  label: z.string().max(80).nullable().optional(),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    return NextResponse.json({
      configs: await listSettlementChainConfigs(supabase, auth.companyId),
      // Whether a platform-wide fallback exists at all. The ADDRESS is not
      // returned — it is deployment configuration, not tenant data, and echoing
      // an operator's env var into a tenant-facing response is how internal
      // configuration leaks.
      platformFallbackConfigured: Boolean(process.env.SETTLEMENT_VERIFYING_CONTRACT?.trim()),
    });
  } catch (e) {
    return apiError(e, "settlement-chain-configs GET");
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const parsed = UpsertSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const config = await upsertSettlementChainConfig(supabase, auth.companyId, parsed.data);
    return NextResponse.json({ config });
  } catch (e) {
    if (e instanceof InvalidFinanceDetailsError) {
      return NextResponse.json(
        { error: "INVALID_CHAIN_CONFIG", reasons: e.reasons },
        { status: 400 }
      );
    }
    return apiError(e, "settlement-chain-configs PUT");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "VALIDATION_ERROR", detail: "id is required" }, { status: 400 });
    }
    if (!(await deleteSettlementChainConfig(supabase, auth.companyId, id))) {
      return NextResponse.json({ error: "CHAIN_CONFIG_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return apiError(e, "settlement-chain-configs DELETE", { CHAIN_CONFIG_NOT_FOUND: 404 });
  }
}
