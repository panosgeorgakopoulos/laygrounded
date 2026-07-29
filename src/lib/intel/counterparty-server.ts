// Database bridge for the counterparty risk profile and the settlement
// expectation model. All I/O here; the judgement is in `counterparty.ts` and
// `settlement/expectation.ts`, both pure.
//
// Scope discipline, restated because it is the load-bearing property: every
// query below is filtered to ONE company id, taken from the authenticated
// session by the route. There is no cross-tenant read in this file. See the
// header of `counterparty.ts` for why.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCounterpartyProfile,
  type CounterpartyClaimRecord,
  type CounterpartyProfile,
  type SanctionsSnapshot,
} from "@/lib/intel/counterparty";
import {
  expectSettlement,
  expectMarketSettlement,
  postureFromVerdicts,
  type ClaimProfile,
  type SettlementExpectation,
  type SettlementExpectationPair,
  type SettlementObservation,
} from "@/lib/settlement/expectation";
import { computeTimeBar } from "@/lib/time-bar";

const MS_PER_DAY = 86_400_000;
const CONFIRMED = ["accepted", "edited"];

/** Owner's claimed position on a claim: demurrage earned less despatch owed. */
function claimedNet(calc: { demurrage_amount?: number; despatch_amount?: number } | null) {
  if (!calc) return null;
  return (calc.demurrage_amount ?? 0) - (calc.despatch_amount ?? 0);
}

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const d = (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
}

interface RawClaim {
  id: string;
  counterparty_name: string | null;
  cp_form: string | null;
  cp_terms: { days_basis?: string } | null;
  settled_amount: number | null;
  settled_at: string | null;
  created_at: string | null;
  time_bar_days: number | null;
}

/**
 * Loads one company's claims plus the per-claim facts both models need, in a
 * fixed number of round trips rather than one per claim.
 */
async function loadCompanyBook(companyId: string, supabase: SupabaseClient) {
  const { data: claims, error } = await supabase
    .from("claims")
    .select("id, counterparty_name, cp_form, cp_terms, settled_amount, settled_at, created_at, time_bar_days")
    .eq("company_id", companyId);
  if (error) throw new Error(`BOOK_QUERY_FAILED: ${error.message}`);

  const rows = (claims ?? []) as RawClaim[];
  const ids = rows.map((c) => c.id);
  if (ids.length === 0) {
    return { rows, calcs: {}, verdicts: {}, proposals: {}, events: {} } as const;
  }

  const [{ data: calcRows }, { data: evidenceRows }, { data: proposalRows }, { data: eventRows }] =
    await Promise.all([
      supabase
        .from("laytime_calculations")
        .select("claim_id, demurrage_amount, despatch_amount, computed_at")
        .in("claim_id", ids)
        .order("computed_at", { ascending: false }),
      supabase.from("evidence_checks").select("claim_id, verdict").in("claim_id", ids),
      supabase.from("event_proposals").select("claim_id, status").in("claim_id", ids),
      supabase
        .from("sof_events")
        .select("claim_id, event_type, occurred_at")
        .in("claim_id", ids)
        .in("status", CONFIRMED),
    ]);

  const calcs: Record<string, { demurrage_amount: number; despatch_amount: number }> = {};
  for (const c of calcRows ?? []) {
    // Ordered newest-first, so the first sighting of a claim is its latest.
    if (!calcs[c.claim_id]) {
      calcs[c.claim_id] = {
        demurrage_amount: c.demurrage_amount ?? 0,
        despatch_amount: c.despatch_amount ?? 0,
      };
    }
  }

  const verdicts: Record<string, string[]> = {};
  for (const e of evidenceRows ?? []) (verdicts[e.claim_id] ??= []).push(e.verdict);

  const proposals: Record<string, { raised: number; rejected: number }> = {};
  for (const p of proposalRows ?? []) {
    const bucket = (proposals[p.claim_id] ??= { raised: 0, rejected: 0 });
    bucket.raised += 1;
    if (p.status === "rejected") bucket.rejected += 1;
  }

  const events: Record<string, Array<{ event_type: string; occurred_at: string }>> = {};
  for (const e of eventRows ?? []) {
    (events[e.claim_id] ??= []).push({ event_type: e.event_type, occurred_at: e.occurred_at });
  }

  return { rows, calcs, verdicts, proposals, events } as const;
}

/**
 * Claim SHAPE, and nothing else.
 *
 * The parameter is deliberately narrower than `RawClaim`: everything a profile
 * is built from is contractual form, and no party identity is reachable from
 * here. That is what lets the same helper serve the cross-tenant market sample
 * — the market query does not even select `counterparty_name`, and this
 * signature is what stops it drifting back in.
 */
function toClaimProfile(
  claim: { cp_form: string | null; cp_terms: { days_basis?: string } | null },
  verdicts: string[],
  contested: boolean
): ClaimProfile {
  return {
    cpForm: claim.cp_form ?? "GENCON94",
    daysBasis: claim.cp_terms?.days_basis ?? "SHINC",
    evidencePosture: postureFromVerdicts(verdicts),
    contested,
  };
}

/**
 * Risk profile for one counterparty, from the viewing company's own book.
 *
 * Matching is on the exact stored `counterparty_name`. Deliberately not fuzzy:
 * silently merging "Cargill" and "Cargill International" would attribute one
 * legal entity's behaviour to another, which is exactly the error this kind of
 * profile must not make. Normalising counterparty identity is a data-quality
 * feature with its own review step, not something to guess at read time.
 */
export async function loadCounterpartyProfile(
  companyId: string,
  counterpartyName: string,
  supabase: SupabaseClient
): Promise<CounterpartyProfile> {
  const { rows, calcs, verdicts, proposals, events } = await loadCompanyBook(companyId, supabase);
  const mine = rows.filter((c) => c.counterparty_name === counterpartyName);

  const records: CounterpartyClaimRecord[] = mine.map((c) => {
    const timeBar = computeTimeBar({
      timeBarDays: c.time_bar_days ?? 90,
      events: events[c.id] ?? [],
      hasSofDocument: true,
      hasValidCpTerms: true,
      hasCalculation: !!calcs[c.id],
    });
    return {
      claimId: c.id,
      claimedAmount: claimedNet(calcs[c.id] ?? null),
      settledAmount: c.settled_amount,
      daysToSettle: daysBetween(c.created_at, c.settled_at),
      evidenceVerdicts: verdicts[c.id] ?? [],
      proposalsRaised: proposals[c.id]?.raised ?? 0,
      proposalsRejected: proposals[c.id]?.rejected ?? 0,
      timeBarExpired: timeBar.state === "expired",
    };
  });

  // Sanctions screening is per claim; the most recent counterparty check across
  // this counterparty's claims is the one reported.
  let sanctions: SanctionsSnapshot | null = null;
  if (mine.length > 0) {
    const { data: checks } = await supabase
      .from("compliance_checks")
      .select("verdict, checked_at, source")
      .in("claim_id", mine.map((c) => c.id))
      .eq("subject_type", "counterparty")
      .order("checked_at", { ascending: false })
      .limit(1);
    const latest = checks?.[0];
    if (latest) {
      sanctions = {
        verdict: latest.verdict,
        checkedAt: latest.checked_at ?? null,
        source: latest.source ?? "",
      };
    }
  }

  return buildCounterpartyProfile({ counterpartyName, claims: records, sanctions });
}

/** Distinct counterparties in a company's book, with claim counts. */
export async function listCounterparties(
  companyId: string,
  supabase: SupabaseClient
): Promise<Array<{ name: string; claims: number }>> {
  const { data, error } = await supabase
    .from("claims")
    .select("counterparty_name")
    .eq("company_id", companyId)
    .not("counterparty_name", "is", null);
  if (error) throw new Error(`BOOK_QUERY_FAILED: ${error.message}`);

  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const n = r.counterparty_name as string;
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, claims]) => ({ name, claims }))
    .sort((a, b) => b.claims - a.claims || a.name.localeCompare(b.name));
}

/**
 * Whether cross-tenant market expectations are switched on.
 *
 * Same gate style as the published congestion index (`=== "1"`, opt-in). Read
 * at request time inside a dynamic route — note the repo trap that an ISR page
 * would freeze this at build time, so do not move this check into one.
 */
export function marketExpectationsEnabled(): boolean {
  return process.env.PUBLIC_MARKET_EXPECTATIONS === "1";
}

const MARKET_SAMPLE_LIMIT = 2000;

/**
 * Cross-tenant settled claims, for the market baseline.
 *
 * Requires a service-role client: RLS scopes every claim read to one company,
 * which is exactly right for user data and exactly wrong for an aggregate. The
 * safety therefore lives here rather than in the database, and it is threefold:
 * the caller is an authenticated route, the viewer's own company is stripped
 * inside `expectMarketSettlement`, and only aggregates ever leave the pure
 * model — the raw rows loaded here never reach a response.
 *
 * A direct query rather than a matview because settled claims are the rarest
 * rows in the schema. If that stops being true, this is the thing to promote to
 * a matview, with the SECURITY DEFINER grant discipline the others use.
 */
async function loadMarketSettlements(
  service: SupabaseClient
): Promise<SettlementObservation[]> {
  const { data: claims, error } = await service
    .from("claims")
    .select("id, company_id, cp_form, cp_terms, settled_amount, settled_at, created_at")
    .not("settled_amount", "is", null)
    .limit(MARKET_SAMPLE_LIMIT);
  if (error) throw new Error(`MARKET_QUERY_FAILED: ${error.message}`);

  const rows = claims ?? [];
  const ids = rows.map((c) => c.id);
  if (ids.length === 0) return [];

  const [{ data: calcRows }, { data: evidenceRows }, { data: proposalRows }] = await Promise.all([
    service
      .from("laytime_calculations")
      .select("claim_id, demurrage_amount, despatch_amount, computed_at")
      .in("claim_id", ids)
      .order("computed_at", { ascending: false }),
    service.from("evidence_checks").select("claim_id, verdict").in("claim_id", ids),
    service.from("event_proposals").select("claim_id").in("claim_id", ids),
  ]);

  const calcs: Record<string, { demurrage_amount: number; despatch_amount: number }> = {};
  for (const c of calcRows ?? []) {
    if (!calcs[c.claim_id]) {
      calcs[c.claim_id] = {
        demurrage_amount: c.demurrage_amount ?? 0,
        despatch_amount: c.despatch_amount ?? 0,
      };
    }
  }
  const verdicts: Record<string, string[]> = {};
  for (const e of evidenceRows ?? []) (verdicts[e.claim_id] ??= []).push(e.verdict);
  const contested = new Set((proposalRows ?? []).map((p) => p.claim_id));

  return rows.map((c) => ({
    companyId: c.company_id,
    claimedAmount: claimedNet(calcs[c.id] ?? null) ?? 0,
    settledAmount: c.settled_amount ?? 0,
    daysToSettle: daysBetween(c.created_at, c.settled_at),
    profile: toClaimProfile(c, verdicts[c.id] ?? [], contested.has(c.id)),
  }));
}

/**
 * Settlement expectation for one claim: the company's own history, and — when
 * `PUBLIC_MARKET_EXPECTATIONS=1` — the market's alongside it.
 *
 * `service` is optional so the own-book answer never depends on a privileged
 * client being available; without it the market side reports as switched off
 * rather than silently degrading to your own numbers relabelled as the market's.
 */
export async function loadSettlementExpectation(
  companyId: string,
  claimId: string,
  supabase: SupabaseClient,
  service?: SupabaseClient
): Promise<SettlementExpectationPair> {
  const { rows, calcs, verdicts, proposals } = await loadCompanyBook(companyId, supabase);

  const target = rows.find((c) => c.id === claimId);
  if (!target) throw new Error("CLAIM_NOT_FOUND");

  const targetProfile = toClaimProfile(
    target,
    verdicts[claimId] ?? [],
    (proposals[claimId]?.raised ?? 0) > 0
  );

  const ownHistory: SettlementObservation[] = rows
    .filter((c) => c.id !== claimId && c.settled_amount !== null)
    .map((c) => ({
      companyId,
      claimedAmount: claimedNet(calcs[c.id] ?? null) ?? 0,
      settledAmount: c.settled_amount ?? 0,
      daysToSettle: daysBetween(c.created_at, c.settled_at),
      profile: toClaimProfile(c, verdicts[c.id] ?? [], (proposals[c.id]?.raised ?? 0) > 0),
    }));

  const own = expectSettlement(targetProfile, ownHistory);

  if (!marketExpectationsEnabled()) {
    return {
      own,
      market: null,
      marketUnavailableReason:
        "Market comparison is switched off for this deployment (PUBLIC_MARKET_EXPECTATIONS).",
    };
  }
  if (!service) {
    return {
      own,
      market: null,
      marketUnavailableReason: "Market comparison is unavailable — no privileged client.",
    };
  }

  const marketHistory = await loadMarketSettlements(service);
  return {
    own,
    // The target claim is excluded by id as well as by company: a claim that is
    // itself already settled would otherwise sit in its own baseline.
    market: expectMarketSettlement(
      targetProfile,
      marketHistory.filter((h) => h.companyId !== companyId),
      companyId
    ),
    marketUnavailableReason: null,
  };
}

/** Re-exported so callers can type a single expectation without reaching in. */
export type { SettlementExpectation };
