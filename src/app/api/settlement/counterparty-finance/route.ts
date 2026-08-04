// Settlement party banking and wallet details.
//
// Tenant-scoped CRUD over `counterparty_finance`. Deliberately NOT the
// service-role client: these are user data — somebody has to type the IBAN in —
// so they go through the cookie client and RLS, unlike `settlement_payloads`,
// which is generated and must never be user-editable.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, requireCapability } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import {
  InvalidFinanceDetailsError,
  deleteCounterpartyFinance,
  listCounterpartyFinance,
  upsertCounterpartyFinance,
} from "@/lib/settlement/counterparty-finance-server";

const UpsertSchema = z.object({
  partyKind: z.enum(["self", "counterparty"]),
  /** Required for `counterparty`; it is the match key against claims.counterparty_name. */
  counterpartyName: z.string().max(200).nullable().optional(),
  legalName: z.string().min(1).max(200),
  country: z.string().length(2).nullable().optional(),
  iban: z.string().max(64).nullable().optional(),
  bic: z.string().max(16).nullable().optional(),
  bankName: z.string().max(200).nullable().optional(),
  walletAddress: z.string().max(64).nullable().optional(),
  chainId: z.number().int().positive().nullable().optional(),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    return NextResponse.json({
      records: await listCounterpartyFinance(supabase, auth.companyId),
    });
  } catch (e) {
    return apiError(e, "counterparty-finance GET");
  }
}

export async function PUT(req: NextRequest) {
  try {
    // This record IS the account a settlement instruction pays into. Editing it
    // redirects money without touching a single figure on the claim.
    const auth = await requireCapability("finance.counterparty", { req });
    const supabase = await createClient();

    const parsed = UpsertSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const record = await upsertCounterpartyFinance(supabase, auth.companyId, parsed.data);
    return NextResponse.json({ record });
  } catch (e) {
    // Returned directly rather than thrown through `apiError`: the sentinel is
    // matched against the WHOLE message string, so a decorated message falls
    // through to an opaque 500 — and the specific reasons are the entire value
    // of this response to someone correcting an IBAN.
    if (e instanceof InvalidFinanceDetailsError) {
      return NextResponse.json(
        { error: "INVALID_FINANCE_DETAILS", reasons: e.reasons },
        { status: 400 }
      );
    }
    return apiError(e, "counterparty-finance PUT");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireCapability("finance.counterparty", { req });
    const supabase = await createClient();

    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "VALIDATION_ERROR", detail: "id is required" }, { status: 400 });
    }

    const deleted = await deleteCounterpartyFinance(supabase, auth.companyId, id);
    if (!deleted) {
      return NextResponse.json({ error: "FINANCE_RECORD_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return apiError(e, "counterparty-finance DELETE", { FINANCE_RECORD_NOT_FOUND: 404 });
  }
}
