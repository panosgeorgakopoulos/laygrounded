// Pre-fixture CP analyzer: paste a charter party or recap, get priced risks.
//
// Orchestration only. The parsing is `api/plg.ts`, the provenance check is
// `grounding.ts`, the judgement is `risk.ts`, and the money comes from the same
// scenario evaluator the clause P&L uses. Nothing here decides anything.
//
// The extraction path is deliberately deterministic-first. `parseFixtureRecap`
// is regex over known charter-party tokens: it cannot hallucinate, it needs no
// API key, and it already knows the token forms that matter. An LLM pass is the
// natural enhancement for prose charter parties, and `verifyExtraction` exists
// to police it — but the analyzer must work without one, because a tool that
// silently degrades to nothing when a quota runs out is worse than a tool that
// tells you what it could and could not read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFixtureRecap } from "@/lib/api/plg";
import { analyzeCpRisk, type CpRiskReport } from "@/lib/prefixture/risk";
import { MIN_SAMPLE_VOYAGES, type OracleVoyageStat } from "@/lib/oracle/pricing";
import type { CpTerms } from "@/lib/laytime/types";

export interface AnalyzeInput {
  /** Raw pasted charter party or fixture recap. */
  text: string;
  /** Intended load/discharge port. Falls back to whatever the recap names. */
  port?: string;
  cargo?: string;
  /** Intended laycan month, 1-12. Drives the seasonal sample. */
  month: number;
}

export interface KnowledgeAnchor {
  clauseRef: string;
  slug: string;
  title: string;
}

export interface AnalyzeResult {
  terms: CpTerms;
  /** Fields the parser actually found in the text. */
  matched: string[];
  /**
   * Analysed CpTerms fields the parser did not find, so every figure resting on
   * one is indicative. Derived from `matched`, not from the parser's own
   * `missing` list — see `unknownFields`.
   */
  missing: string[];
  parseWarnings: string[];
  report: CpRiskReport;
  /** Knowledge-graph entries for the clause refs cited, keyed by ref. */
  knowledge: KnowledgeAnchor[];
  /** Port/month the historical sample was drawn for, once resolved. */
  sampleRoute: { port: string | null; month: number };
}

interface StatRow {
  cargo_key: string;
  month: number;
  weather_delay_hours: number;
  used_hours: number;
  allowed_hours: number;
  excess_hours: number;
  verified: boolean;
}

function toStat(r: StatRow): OracleVoyageStat {
  return {
    month: r.month,
    weatherDelayHours: r.weather_delay_hours,
    usedHours: r.used_hours,
    allowedHours: r.allowed_hours,
    excessHours: r.excess_hours,
    verified: r.verified,
  };
}

/**
 * Historical voyages for a route, with the oracle's own selection discipline:
 * narrow by cargo when that leaves a usable sample, prefer voyages whose
 * evidence was never contradicted, and fall back rather than refuse.
 *
 * Reads the cross-tenant `oracle_voyage_stats` matview, which carries no RLS
 * and no end-user grants — hence the service-role client, and hence the fact
 * that only aggregates computed from these rows ever reach a response.
 */
async function loadRouteSamples(
  service: SupabaseClient,
  port: string,
  month: number,
  cargo?: string
): Promise<OracleVoyageStat[]> {
  const portKey = port.trim().toLowerCase();
  const { data, error } = await service
    .from("oracle_voyage_stats")
    .select("cargo_key, month, weather_delay_hours, used_hours, allowed_hours, excess_hours, verified")
    .eq("port_key", portKey)
    .eq("month", month);
  if (error) throw new Error(`ORACLE_READ_FAILED: ${error.message}`);

  const rows = (data ?? []) as StatRow[];
  let selected = rows;

  const cargoKey = cargo?.trim().toLowerCase();
  if (cargoKey) {
    const cargoRows = rows.filter((r) => r.cargo_key === cargoKey);
    if (cargoRows.length >= MIN_SAMPLE_VOYAGES) selected = cargoRows;
  }

  const verified = selected.filter((r) => r.verified);
  if (verified.length >= MIN_SAMPLE_VOYAGES) selected = verified;

  return selected.map(toStat);
}

/**
 * Knowledge-graph entries for the clause references a report cites.
 *
 * A risk whose clause has no entry simply gets no anchor. The alternative —
 * generating commentary to fill the gap — is the exact failure the knowledge
 * base was built to avoid: `kb_precedents` ships empty and demands a
 * `source_label` for the same reason.
 */
async function loadKnowledge(
  supabase: SupabaseClient,
  clauseRefs: string[]
): Promise<KnowledgeAnchor[]> {
  const refs = [...new Set(clauseRefs)];
  if (refs.length === 0) return [];

  const { data, error } = await supabase
    .from("kb_clauses")
    .select("slug, title, clause_ref")
    .in("clause_ref", refs);
  if (error) return []; // a missing anchor must never fail the analysis

  return (data ?? [])
    .filter((r) => r.clause_ref)
    .map((r) => ({ clauseRef: r.clause_ref as string, slug: r.slug, title: r.title }));
}

/**
 * CpTerms fields whose absence changes the analysis.
 *
 * Unknowns are derived by subtracting `matched` from this list rather than
 * trusting the parser's own `missing` array. That array is only as complete as
 * the parser's bookkeeping: a field the parser does not track at all appears in
 * neither list, and the analyzer would then price a silent default as if it had
 * read it from the contract. Discovered exactly that way — a recap reading
 * "TURN TIME: NIL" was analysed as a comfortable 6-hour turn time.
 */
const ANALYSED_TERM_FIELDS = [
  "laytime_allowed_hours",
  "turn_time_hours",
  "days_basis",
  "nor_variant",
  "demurrage_rate",
  "despatch_rate",
] as const;

function unknownFields(matched: string[]): string[] {
  const found = new Set(matched);
  return ANALYSED_TERM_FIELDS.filter((f) => !found.has(f));
}

export async function analyzeCharterParty(
  input: AnalyzeInput,
  supabase: SupabaseClient,
  service: SupabaseClient
): Promise<AnalyzeResult> {
  const parsed = parseFixtureRecap(input.text);

  // The caller's stated port wins over the parsed one: they are analysing a
  // prospective fixture, and the route they intend to run is the route to price
  // against, even when the pasted text names a different one.
  const port = input.port?.trim() || parsed.claim.port || null;

  const samples = port ? await loadRouteSamples(service, port, input.month, input.cargo) : [];

  const unknown = unknownFields(parsed.matched);

  const report = analyzeCpRisk({
    terms: parsed.cpTerms,
    samples,
    missingFields: unknown,
  });

  const knowledge = await loadKnowledge(
    supabase,
    report.risks.map((r) => r.clauseRef).filter((r): r is string => r !== null)
  );

  if (!port) {
    report.limitations.unshift(
      "No port could be determined from the text and none was supplied, so no historical sample was loaded."
    );
  }

  return {
    terms: parsed.cpTerms,
    matched: parsed.matched,
    missing: unknown,
    parseWarnings: parsed.warnings,
    report,
    knowledge,
    sampleRoute: { port, month: input.month },
  };
}
