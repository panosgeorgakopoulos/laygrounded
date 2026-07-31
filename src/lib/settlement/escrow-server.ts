// Database bridge for settlement payload generation.
//
// All I/O here; the arithmetic and the payload shapes stay pure in `escrow.ts`.
//
// WHY TERMINAL AND CARBON ARE CALLER-SUPPLIED, NOT LOADED.
// Neither is persisted anywhere. `clause_flags` has no terminal-shortfall row
// (it is keyed on `event_id` and holds only clause_ref/severity/note), and the
// ETS addendum is generated as a PDF without a stored allocation — `drafts` has
// no `ets_addendum` kind and no metadata column. Both are computed on demand.
//
// So this module does NOT recompute them, for two reasons:
//   * the ETS figure depends on a live EUA price, and a mock price reaching a
//     payment instruction is exactly the failure the provenance discipline
//     exists to prevent;
//   * a terminal shortfall nobody has reviewed is not an input to a payment.
// They are optional arguments a caller passes once a human has reviewed them.
// Absent, `escrow.ts` excludes them and says so in `memos`.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSettlementPayload,
  digestOf,
  type CarbonLiability,
  type EscrowInput,
  type SettlementParty,
  type SettlementPayload,
  type TerminalShortfall,
} from "./escrow";

export interface LoadedSettlement {
  payload: SettlementPayload;
  digest: string;
  companyId: string;
}

export interface SettlementOverrides {
  /** Only pass when a deduction basis has actually been established. */
  terminal?: TerminalShortfall | null;
  /** Only pass when the ETS allocation has been determined and reviewed. */
  carbon?: CarbonLiability | null;
  /** Bank details, when the tenant has configured them. */
  ownerBank?: Partial<SettlementParty>;
  chartererBank?: Partial<SettlementParty>;
  chain?: EscrowInput["chain"];
}

export async function buildSettlementForClaim(
  db: SupabaseClient,
  claimId: string,
  issuedAt: string,
  overrides: SettlementOverrides = {}
): Promise<LoadedSettlement> {
  const { data: claim } = await db
    .from("claims")
    .select(
      "id, company_id, vessel, voyage_ref, port, counterparty_name, tenant_role, external_ref, agreed_at, agreed_calculation_id"
    )
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const { data: calc } = await db
    .from("laytime_calculations")
    .select("id, demurrage_amount, despatch_amount, currency, computed_at")
    .eq("claim_id", claimId)
    .maybeSingle();
  if (!calc) throw new Error("NO_CALCULATION");

  // Open proposals are the "undisputed" test. Counted rather than merely
  // checked, so the blocker can say how many.
  const { count: openDisputes } = await db
    .from("event_proposals")
    .select("id", { count: "exact", head: true })
    .eq("claim_id", claimId)
    .eq("status", "pending");

  const { data: company } = await db
    .from("companies")
    .select("name")
    .eq("id", claim.company_id)
    .maybeSingle();

  // The tenant is one side of the fixture and `counterparty_name` is the other.
  // Which is the owner and which the charterer follows from `tenant_role`; when
  // that is null or 'trader' the pure module refuses to name a debtor at all.
  const tenantParty: SettlementParty = {
    name: company?.name ?? "",
    accountId: null,
    bic: null,
    country: null,
    walletAddress: null,
  };
  const counterparty: SettlementParty = {
    name: claim.counterparty_name ?? "",
    accountId: null,
    bic: null,
    country: null,
    walletAddress: null,
  };

  const tenantIsOwner = claim.tenant_role === "owner";
  const owner = merge(tenantIsOwner ? tenantParty : counterparty, overrides.ownerBank);
  const charterer = merge(tenantIsOwner ? counterparty : tenantParty, overrides.chartererBank);

  const input: EscrowInput = {
    claim: {
      id: claim.id,
      // The ERP reference where we have one: it is what a bank statement and a
      // counterparty's ledger will both recognise.
      reference: claim.external_ref || claim.id,
      vessel: claim.vessel,
      voyageRef: claim.voyage_ref,
      port: claim.port,
    },
    calculation: {
      calculationId: calc.id,
      demurrageAmount: calc.demurrage_amount ?? 0,
      despatchAmount: calc.despatch_amount ?? 0,
      currency: calc.currency ?? "USD",
      computedAt: calc.computed_at,
    },
    agreedAt: claim.agreed_at,
    openDisputes: openDisputes ?? 0,
    terminal: overrides.terminal ?? null,
    carbon: overrides.carbon ?? null,
    owner,
    charterer,
    tenantRole: claim.tenant_role,
    chain: overrides.chain ?? null,
    issuedAt,
  };

  // A settlement generated against a calculation OTHER than the agreed one is
  // settling numbers nobody signed off. Surfaced as a blocker rather than
  // silently using the latest.
  const payload = buildSettlementPayload(input);
  if (
    claim.agreed_calculation_id &&
    claim.agreed_calculation_id !== calc.id &&
    !payload.blockers.some((b) => b.includes("recomputed"))
  ) {
    payload.blockers.push(
      `claim was agreed against calculation ${claim.agreed_calculation_id} but the current ` +
        `calculation is ${calc.id} — it has been recomputed since agreement and must be re-agreed`
    );
    payload.ready = false;
  }

  return { payload, digest: await digestOf(payload), companyId: claim.company_id };
}

/**
 * Persists a generated payload, idempotently.
 *
 * Keyed on (claim, calculation): regenerating for the same agreed calculation
 * is the same document. A recompute produces a different calculation id and
 * therefore a new row — the record of what was agreed before is never
 * overwritten.
 */
export async function persistSettlementPayload(
  db: SupabaseClient,
  loaded: LoadedSettlement
): Promise<{ persisted: boolean }> {
  const { error } = await db.from("settlement_payloads").insert({
    company_id: loaded.companyId,
    claim_id: loaded.payload.claimId,
    calculation_id: loaded.payload.calculationId,
    settlement_ref: loaded.payload.settlementRef,
    payload: loaded.payload,
    digest: loaded.digest,
    ready: loaded.payload.ready,
    blockers: loaded.payload.blockers,
  });

  if (error) {
    if (error.code === "23505") return { persisted: false }; // already generated
    throw new Error(`SETTLEMENT_PAYLOAD_PERSIST_FAILED: ${error.message}`);
  }
  return { persisted: true };
}

function merge(base: SettlementParty, over: Partial<SettlementParty> | undefined): SettlementParty {
  if (!over) return base;
  return {
    ...base,
    ...over,
    // A blank override must not erase a name we do have.
    name: over.name?.trim() ? over.name : base.name,
  };
}
