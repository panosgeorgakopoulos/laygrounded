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
//
// BANK AND WALLET DETAILS *ARE* LOADED, and the distinction from terminal and
// carbon is the point. Those two are DERIVED figures whose value depends on a
// live price or an unreviewed computation. An IBAN is a stored fact somebody
// typed in and validated (`counterparty-finance.ts` checks the ISO 13616 MOD-97
// checksum, which is the account holder's own bank's arithmetic, not ours).
// Loading a stored fact is not the same as inventing a derived one — and where
// the fact is absent it stays absent, reported through `missingForBank` /
// `missingForChain` rather than filled with a placeholder.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveChainAgreement,
  type CounterpartyFinanceRecord,
} from "./counterparty-finance";
import {
  loadCounterpartyFinance,
  loadSelfFinance,
  loadSettlementChainConfig,
} from "./counterparty-finance-server";
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

  const [{ data: company }, selfFinance, counterpartyFinance] = await Promise.all([
    db.from("companies").select("name").eq("id", claim.company_id).maybeSingle(),
    loadSelfFinance(db, claim.company_id),
    loadCounterpartyFinance(db, claim.company_id, claim.counterparty_name),
  ]);

  // The tenant is one side of the fixture and `counterparty_name` is the other.
  // Which is the owner and which the charterer follows from `tenant_role`; when
  // that is null or 'trader' the pure module refuses to name a debtor at all.
  //
  // Details are hydrated from `counterparty_finance` where they exist and stay
  // null where they do not. Nothing is defaulted or inferred: a placeholder IBAN
  // would make the payload look actionable and either fail at the bank or pay
  // the wrong account, so absence stays absence and surfaces through
  // `missingForBank` / `missingForChain`.
  //
  // The configured `legalName` wins over the company/claim name when present.
  // It is the account holder as the bank knows them, and a transfer to
  // "ACME Shipping Ltd" against an account held by "ACME Shipping Limited" is
  // rejected or, worse, returned weeks later.
  const tenantParty: SettlementParty = fromFinance(company?.name ?? "", selfFinance);
  const counterparty: SettlementParty = fromFinance(
    claim.counterparty_name ?? "",
    counterpartyFinance
  );

  const tenantIsOwner = claim.tenant_role === "owner";
  const owner = merge(tenantIsOwner ? tenantParty : counterparty, overrides.ownerBank);
  const charterer = merge(tenantIsOwner ? counterparty : tenantParty, overrides.chartererBank);

  // Chain context. Derived from the parties rather than assumed, and only when
  // BOTH are configured on the same chain — see `resolveChainAgreement`. An
  // explicit `overrides.chain` still wins: a caller that knows the escrow
  // deployment is more authoritative than an inference.
  const ownerChain = tenantIsOwner ? selfFinance : counterpartyFinance;
  const chartererChain = tenantIsOwner ? counterpartyFinance : selfFinance;
  const agreement = resolveChainAgreement(ownerChain ?? {}, chartererChain ?? {});

  // The escrow deployment for THAT chain. Looked up rather than taken from a
  // global setting, because a contract address is a deployment on one chain —
  // the same 20 bytes on another chain are a different contract, usually
  // nothing at all. The env var remains a platform-wide fallback for installs
  // running a single deployment.
  const configured =
    agreement.chainId !== null
      ? await loadSettlementChainConfig(db, claim.company_id, agreement.chainId)
      : null;
  const envContract = process.env.SETTLEMENT_VERIFYING_CONTRACT?.trim() || null;
  const verifyingContract = configured?.verifyingContract ?? envContract;

  const chain: EscrowInput["chain"] =
    overrides.chain ??
    (agreement.chainId !== null && verifyingContract
      ? {
          chainId: agreement.chainId,
          verifyingContract,
          tokenAddress:
            configured?.tokenAddress ?? process.env.SETTLEMENT_TOKEN_ADDRESS?.trim() ?? null,
        }
      : null);

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
    chain,
    issuedAt,
  };

  // A settlement generated against a calculation OTHER than the agreed one is
  // settling numbers nobody signed off. Surfaced as a blocker rather than
  // silently using the latest.
  const payload = buildSettlementPayload(input);

  // A cross-chain pair is a blocker, not a silently-dropped chain leg. Mirrors
  // the currency rule: components in different currencies become separate legs
  // rather than being netted at an invented rate, and bridging two chains is
  // the same decision with custody consequences attached.
  if (agreement.conflict) {
    payload.blockers.push(agreement.conflict);
    payload.ready = false;
  }

  // Both parties hold wallets on an agreed chain but no escrow is deployed for
  // it. A memo rather than a blocker: the BANK leg is complete and settleable,
  // and refusing the whole payload because the optional on-chain route is
  // unconfigured would withhold a working instruction over an absent one. Said
  // out loud rather than left as a silently missing `eip712`, because "there is
  // no chain leg" and "we forgot to configure the contract" look identical from
  // the outside.
  if (agreement.chainId !== null && !verifyingContract && !overrides.chain) {
    payload.memos.push(
      `Both parties are configured on chain ${agreement.chainId}, but no escrow contract is ` +
        `registered for it — no EIP-712 leg was generated. Add the deployment under ` +
        `Settings → Settlement & Banking.`
    );
  }

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

/**
 * Builds a settlement party from a configured finance record.
 *
 * `fallbackName` is the company or claim name — used only when no record exists
 * or it carries no legal name, so a payload still names the parties even when
 * nobody has entered banking details yet.
 */
function fromFinance(
  fallbackName: string,
  finance: CounterpartyFinanceRecord | null
): SettlementParty {
  return {
    name: finance?.legalName?.trim() || fallbackName,
    accountId: finance?.iban ?? null,
    bic: finance?.bic ?? null,
    country: finance?.country ?? null,
    walletAddress: finance?.walletAddress ?? null,
  };
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
