// Terminal & Agent Honesty Index — pure scoring over the `honesty_index`
// materialized view (cross-company aggregate of evidence-check verdicts).
// No I/O here: the API route reads the matview with the service-role client
// and maps rows through scoreHonesty(); this module just turns counts into
// bands and pre-fixture warning copy.

/** One row of the `honesty_index` materialized view (snake_case, as stored). */
export interface HonestyIndexRow {
  subject_type: "port" | "agent";
  subject_key: string;
  subject_label: string;
  check_type: string; // 'weather' | 'position'
  total_checks: number;
  decisive_checks: number;
  contradicted_checks: number;
  corroborated_checks: number;
  claims_covered: number;
  last_checked_at: string | null;
}

export interface HonestyScore {
  subjectType: "port" | "agent";
  subjectLabel: string;
  checkType: string;
  band: "clean" | "caution" | "high_risk" | "insufficient_data";
  falseClaimRate: number | null;
  decisiveChecks: number;
  contradictedChecks: number;
  claimsCovered: number;
  lastCheckedAt: string | null;
  warning: string | null;
}

// k-anonymity floor: below this many decisive checks a "rate" is both
// statistically meaningless and potentially deanonymizing (a subject seen on
// a single company's two claims would effectively expose that company's
// private verification outcomes). Such subjects are reported as
// insufficient_data with rate and warning suppressed.
export const MIN_DECISIVE_CHECKS = 5;

// Band thresholds on falseClaimRate = contradicted / decisive.
const HIGH_RISK_RATE = 0.3;
const CAUTION_RATE = 0.1;

function subjectNoun(subjectType: "port" | "agent"): string {
  return subjectType === "port" ? "Terminal" : "Agent";
}

function claimPhrase(checkType: string): string {
  return checkType === "position" ? "NOR position claims" : "weather delay claims";
}

function sourcePhrase(checkType: string): string {
  return checkType === "position" ? "independent AIS data" : "independent archive data";
}

/**
 * Warning copy for caution/high_risk subjects, e.g.
 * "Terminal Santos's weather delay claims were contradicted by independent
 * archive data 38% of the time (19 of 50 checks across 30 claims)."
 * Kept as its own pure helper so the phrasing is unit-testable.
 */
export function buildWarning(args: {
  subjectType: "port" | "agent";
  subjectLabel: string;
  checkType: string;
  rate: number;
  contradicted: number;
  decisive: number;
  claims: number;
}): string {
  const pct = Math.round(args.rate * 100);
  return (
    `${subjectNoun(args.subjectType)} ${args.subjectLabel}'s ${claimPhrase(args.checkType)} ` +
    `were contradicted by ${sourcePhrase(args.checkType)} ${pct}% of the time ` +
    `(${args.contradicted} of ${args.decisive} checks across ${args.claims} claims).`
  );
}

/** Pure: one matview row → one scored, presentation-ready record. */
export function scoreHonesty(row: HonestyIndexRow): HonestyScore {
  const base = {
    subjectType: row.subject_type,
    subjectLabel: row.subject_label,
    checkType: row.check_type,
    decisiveChecks: row.decisive_checks,
    contradictedChecks: row.contradicted_checks,
    claimsCovered: row.claims_covered,
    lastCheckedAt: row.last_checked_at,
  };

  if (row.decisive_checks < MIN_DECISIVE_CHECKS) {
    return { ...base, band: "insufficient_data", falseClaimRate: null, warning: null };
  }

  const rate = row.contradicted_checks / row.decisive_checks;
  const band: HonestyScore["band"] =
    rate >= HIGH_RISK_RATE ? "high_risk" : rate >= CAUTION_RATE ? "caution" : "clean";

  const warning =
    band === "clean"
      ? null
      : buildWarning({
          subjectType: row.subject_type,
          subjectLabel: row.subject_label,
          checkType: row.check_type,
          rate,
          contradicted: row.contradicted_checks,
          decisive: row.decisive_checks,
          claims: row.claims_covered,
        });

  return { ...base, band, falseClaimRate: rate, warning };
}
