// LayGrounded shared laytime types — exact spec.

export type EventTypeEnum =
  | "NOR_TENDERED"
  | "ALL_FAST"
  | "HATCH_OPEN"
  | "HATCH_CLOSE"
  | "COMMENCED_LOADING"
  | "COMPLETED_LOADING"
  | "COMMENCED_DISCHARGE"
  | "COMPLETED_DISCHARGE"
  | "WEATHER_DELAY"
  | "WEATHER_DELAY_END"
  | "SHIFTING"
  | "SHIFTING_END"
  | "BERTHED"
  | "EXCEPTED_PERIOD_START"
  | "EXCEPTED_PERIOD_END";

export type NorVariant = "WIBON" | "WIPON" | "WICCON" | "WIFPON";
export type DaysBasis = "SHINC" | "SHEX" | "SHEX-UU" | "WWDSHEX-EIU" | "SSHEX" | "SSHEX-UU" | "WWDSSHEX-EIU";

// Charterparty form the engine applies. GENCON94 = dry bulk (default);
// ASBATANKVOY = tanker running-hours regime (Part II Clauses 6–8).
export type CpForm = "GENCON94" | "ASBATANKVOY";

/**
 * Which RULE SET the engine applies. Not a package version — see
 * `ENGINE_VERSION` in `fingerprint.ts`, which is the release of the code.
 *
 * `1` — the rules as shipped through Phase 7. Carries one known defect: under
 *       GENCON 94 with a SHINC days basis an explicitly agreed
 *       `EXCEPTED_PERIOD` is absorbed by the "Sundays and holidays included"
 *       branch and never deducted.
 * `2` — that defect corrected. Nothing else changes.
 *
 * **Version 1 is not deprecated, it is frozen.** A published calculation is a
 * legal artifact: a claim already served, notarised or agreed must keep
 * reproducing the figures on the document, and an offline verifier handed a
 * 2025 bundle in 2035 has to arrive at the same number an arbitrator read at
 * the time. Silently "fixing" a settled claim would change money nobody
 * re-agreed and break every RFC-3161 anchor over it.
 *
 * Absent means 1. That default is what keeps every legacy row, corpus case and
 * notarised bundle valid without a backfill — a v1 claim is not marked as one,
 * it simply never says otherwise.
 */
export type EngineVersion = 1 | 2;

export const ENGINE_VERSIONS: EngineVersion[] = [1, 2];

/** What a NEW claim gets. Existing claims keep whatever they were computed under. */
export const CURRENT_ENGINE_VERSION: EngineVersion = 2;

/** The single place the "absent means 1" rule is applied. */
export function resolveEngineVersion(terms: { engine_version?: EngineVersion }): EngineVersion {
  return terms.engine_version ?? 1;
}

/**
 * A port's non-working days, supplied by the caller.
 *
 * Until this existed the engine approximated a holiday as a Sunday, because it
 * had no way to know any better — which silently mis-costed every fixture at a
 * port whose holidays fall midweek, in whichever direction the basis runs.
 *
 * `holidays` are LOCAL calendar dates (YYYY-MM-DD) in the claim's
 * `port_timezone`, not instants: a holiday is a day in the port's own reckoning,
 * and resolving it to a UTC range here would shift it across the dateline for
 * exactly the ports where it matters most.
 *
 * `source` is required and carries provenance. A calendar decides whether real
 * money counts, so an entry that cannot say where it came from should not be in
 * a calculation at all — the same discipline the knowledge base applies to case
 * law.
 */
export interface PortCalendar {
  holidays: string[];
  source: string;
}

export interface CpTerms {
  cp_form?: CpForm; // absent = GENCON94 (legacy rows predate the field)
  /**
   * Rule set to apply. Absent = 1, and absence is how every pre-existing claim
   * stays reproducible — see `EngineVersion`. Carried on the terms rather than
   * passed as an argument so it travels with the claim into the offline
   * verifier bundle: a bundle that did not say which rules produced it would
   * not be independently checkable at all.
   */
  engine_version?: EngineVersion;
  laytime_allowed_hours: number;
  load_rate?: number;
  discharge_rate?: number;
  turn_time_hours: number;
  nor_variant: NorVariant;
  days_basis: DaysBasis;
  demurrage_rate: number; // per day
  despatch_rate: number; // per day
  currency: string; // ISO 4217
  port_timezone?: string; // IANA timezone, e.g. "Asia/Singapore"
  /**
   * Optional. Absent means "no calendar known", which reproduces the engine's
   * pre-calendar behaviour exactly — that default is what keeps the 500-case
   * regression corpus valid rather than needing to be re-blessed.
   */
  port_calendar?: PortCalendar;
}

export interface SofEventInput {
  id: string;
  occurred_at: string; // ISO 8601
  event_type: EventTypeEnum;
}

export type BreakdownStatus =
  | "laytime"
  | "demurrage"
  | "excepted"
  | "weather_delay"
  | "shifting";

export interface BreakdownRow {
  start_time: string;
  end_time: string;
  duration_hours: number;
  status: BreakdownStatus;
  counts: boolean;
  clause_ref: string;
  reasoning: string;
}

export interface CalculationTotals {
  allowed_hours: number;
  used_hours: number;
  time_on_demurrage_hours: number;
  time_saved_hours: number;
  // ASBATANKVOY only: demurrage hours billed at half rate under Part II
  // Clause 8 (storm/weather while on demurrage). Absent for GENCON 94.
  demurrage_half_rate_hours?: number;
  demurrage_amount: number;
  despatch_amount: number;
  currency: string;
}

export interface LaytimeResult {
  breakdown: BreakdownRow[];
  totals: CalculationTotals;
}

// === Helper: enum value lists ===
export const EVENT_TYPE_VALUES: EventTypeEnum[] = [
  "NOR_TENDERED",
  "ALL_FAST",
  "HATCH_OPEN",
  "HATCH_CLOSE",
  "COMMENCED_LOADING",
  "COMPLETED_LOADING",
  "COMMENCED_DISCHARGE",
  "COMPLETED_DISCHARGE",
  "WEATHER_DELAY",
  "WEATHER_DELAY_END",
  "SHIFTING",
  "SHIFTING_END",
  "BERTHED",
  "EXCEPTED_PERIOD_START",
  "EXCEPTED_PERIOD_END",
];

export const NOR_VARIANTS: NorVariant[] = ["WIBON", "WIPON", "WICCON", "WIFPON"];
export const DAYS_BASES: DaysBasis[] = ["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"];
export const CP_FORMS: CpForm[] = ["GENCON94", "ASBATANKVOY"];

// === Default CP terms for new claims ===
//
// New claims are stamped with the CURRENT rule set explicitly. A claim created
// today should get the corrected engine, and saying so on the terms is what
// makes that survivable: the value travels into the calculation, the notarised
// derivation record and the verifier bundle, so nobody later has to infer which
// rules applied from a creation date.
export const DEFAULT_CP_TERMS: CpTerms = {
  engine_version: CURRENT_ENGINE_VERSION,
  laytime_allowed_hours: 72,
  load_rate: 5000,
  discharge_rate: 4000,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 25000,
  despatch_rate: 12500,
  currency: "USD",
};
