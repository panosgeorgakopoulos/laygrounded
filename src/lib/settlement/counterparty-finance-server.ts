// Database bridge for settlement party details. All I/O here; the validation
// and normalisation stay pure in `counterparty-finance.ts`.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  partyKeyOf,
  validateCounterpartyFinance,
  type CounterpartyFinanceInput,
  type CounterpartyFinanceRecord,
} from "./counterparty-finance";

const COLUMNS =
  "id, company_id, party_kind, party_key, legal_name, country, iban, bic, bank_name, wallet_address, chain_id";

function toRecord(row: Record<string, unknown>): CounterpartyFinanceRecord {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    partyKind: row.party_kind as CounterpartyFinanceRecord["partyKind"],
    partyKey: (row.party_key as string | null) ?? null,
    legalName: row.legal_name as string,
    country: (row.country as string | null) ?? null,
    iban: (row.iban as string | null) ?? null,
    bic: (row.bic as string | null) ?? null,
    bankName: (row.bank_name as string | null) ?? null,
    walletAddress: (row.wallet_address as string | null) ?? null,
    chainId: (row.chain_id as number | null) ?? null,
  };
}

/** The tenant's own receiving/paying details, or null when never configured. */
export async function loadSelfFinance(
  db: SupabaseClient,
  companyId: string
): Promise<CounterpartyFinanceRecord | null> {
  const { data } = await db
    .from("counterparty_finance")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .eq("party_kind", "self")
    .maybeSingle();
  return data ? toRecord(data) : null;
}

/**
 * A named counterparty's details, matched on the normalised name.
 *
 * A blank or absent `counterparty_name` on the claim returns null rather than
 * matching some arbitrary record — an unnamed counterparty is not a party we
 * can pay.
 */
export async function loadCounterpartyFinance(
  db: SupabaseClient,
  companyId: string,
  counterpartyName: string | null | undefined
): Promise<CounterpartyFinanceRecord | null> {
  const key = counterpartyName?.trim() ? partyKeyOf(counterpartyName) : null;
  if (!key) return null;

  const { data } = await db
    .from("counterparty_finance")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .eq("party_kind", "counterparty")
    .eq("party_key", key)
    .maybeSingle();
  return data ? toRecord(data) : null;
}

export async function listCounterpartyFinance(
  db: SupabaseClient,
  companyId: string
): Promise<CounterpartyFinanceRecord[]> {
  const { data } = await db
    .from("counterparty_finance")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .order("party_kind", { ascending: true })
    .order("legal_name", { ascending: true });
  return (data ?? []).map(toRecord);
}

/**
 * Creates or replaces one record, validating first.
 *
 * Upserts on the same keys the partial unique indexes enforce, so saving the
 * same party twice updates in place rather than accumulating rows that quietly
 * disagree about where the money goes.
 *
 * Throws the sentinel `INVALID_FINANCE_DETAILS` with the collected reasons —
 * note the reasons are carried on a property rather than concatenated into the
 * message, because `apiError` matches sentinels against the WHOLE message
 * string and a decorated one falls through to an opaque 500.
 */
export class InvalidFinanceDetailsError extends Error {
  constructor(public readonly reasons: string[]) {
    super("INVALID_FINANCE_DETAILS");
    this.name = "InvalidFinanceDetailsError";
  }
}

export async function upsertCounterpartyFinance(
  db: SupabaseClient,
  companyId: string,
  input: CounterpartyFinanceInput
): Promise<CounterpartyFinanceRecord> {
  const validated = validateCounterpartyFinance(input);
  if (!validated.ok || !validated.normalised) {
    throw new InvalidFinanceDetailsError(validated.errors);
  }
  const n = validated.normalised;

  const row = {
    company_id: companyId,
    party_kind: n.partyKind,
    party_key: n.partyKey,
    legal_name: n.legalName,
    country: n.country,
    iban: n.iban,
    bic: n.bic,
    bank_name: n.bankName,
    wallet_address: n.walletAddress,
    chain_id: n.chainId,
    updated_at: new Date().toISOString(),
  };

  // The uniqueness is enforced by two PARTIAL indexes ('self' keyed on company,
  // 'counterparty' on company+key), and PostgREST's on_conflict cannot name a
  // partial index. So: find, then update or insert. The unique indexes remain
  // the real guard — a race loses to a 23505, which is the correct outcome.
  const existing = await db
    .from("counterparty_finance")
    .select("id")
    .eq("company_id", companyId)
    .eq("party_kind", n.partyKind)
    .filter("party_key", n.partyKey === null ? "is" : "eq", n.partyKey === null ? null : n.partyKey)
    .maybeSingle();

  if (existing.data?.id) {
    const { data, error } = await db
      .from("counterparty_finance")
      .update(row)
      .eq("id", existing.data.id)
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`FINANCE_PERSIST_FAILED: ${error.message}`);
    return toRecord(data);
  }

  const { data, error } = await db
    .from("counterparty_finance")
    .insert(row)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`FINANCE_PERSIST_FAILED: ${error.message}`);
  return toRecord(data);
}

export async function deleteCounterpartyFinance(
  db: SupabaseClient,
  companyId: string,
  id: string
): Promise<boolean> {
  const { error, count } = await db
    .from("counterparty_finance")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("company_id", companyId);
  if (error) throw new Error(`FINANCE_DELETE_FAILED: ${error.message}`);
  return (count ?? 0) > 0;
}
