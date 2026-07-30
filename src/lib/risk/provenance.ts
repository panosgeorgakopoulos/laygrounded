// Where every number in a risk report came from, and whether the report may be
// acted on.
//
// This module exists because the simulation can run on a mock AIS feed. A mock
// that produces realistic-looking payloads is exactly what makes the ECDF path
// testable without a paid key — and exactly what could put an invented queue
// length in front of a charterer if provenance were an afterthought.
//
// So provenance is not a label attached at render time. It is carried on every
// dimension, it propagates into the persisted row, and one mock dimension is
// enough to strip the whole report of decision-grade status. The report can
// still be produced and read; it simply cannot claim to be measurement.
//
// Same discipline as the rest of the codebase: `unavailable` verdicts,
// `INSUFFICIENT_DATA`, mandatory `source_label`. Never fabricate silently.
//
// Pure.

/**
 * How a dimension's data was obtained.
 *
 * - `live`           — a real external observation (AIS provider, forecast API)
 * - `public_archive` — reanalysis/history from a public archive (ERA5)
 * - `own_book`       — this tenant's own confirmed claims
 * - `mock`           — SYNTHETIC. Never decision-grade.
 * - `assumption`     — a figure the user supplied themselves
 */
export type ProvenanceSource = "live" | "public_archive" | "own_book" | "mock" | "assumption";

export interface DataProvenance {
  source: ProvenanceSource;
  /** Who or what produced it: "datalastic", "open-meteo/gfs_seamless", "user". */
  provider: string;
  /** When the underlying observation was made, when that is meaningful. */
  observedAt: string | null;
  /** One line a reader can act on, naming the source in plain words. */
  label: string;
  /** Set when the dimension could not be resolved at all. */
  unavailableReason?: string;
}

export interface DimensionProvenance {
  weather: DataProvenance;
  congestion: DataProvenance;
  cargoThresholds: DataProvenance;
  eta: DataProvenance;
}

/**
 * Sources that may back a number someone acts on commercially.
 *
 * `mock` is absent by construction, and this is the single place that decides
 * it. A future source is non-decision-grade until someone adds it here on
 * purpose, which is the safe direction for the default to fail.
 */
const DECISION_GRADE_SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>([
  "live",
  "public_archive",
  "own_book",
  "assumption",
]);

export function isDecisionGrade(provenance: DimensionProvenance): boolean {
  return Object.values(provenance).every((p) => DECISION_GRADE_SOURCES.has(p.source));
}

/** The dimensions that disqualified a report, so the UI can name them exactly. */
export function nonDecisionGradeDimensions(provenance: DimensionProvenance): string[] {
  return Object.entries(provenance)
    .filter(([, p]) => !DECISION_GRADE_SOURCES.has((p as DataProvenance).source))
    .map(([dimension]) => dimension);
}

/**
 * The warnings a reader must see before using the numbers.
 *
 * Returned as data rather than rendered text so the API, the UI and the stored
 * row cannot drift into disagreeing about what a report claimed.
 */
export function provenanceCaveats(provenance: DimensionProvenance): string[] {
  const caveats: string[] = [];
  const mocked = Object.entries(provenance).filter(
    ([, p]) => (p as DataProvenance).source === "mock"
  );

  if (mocked.length > 0) {
    caveats.push(
      `SYNTHETIC DATA: ${mocked.map(([d]) => d).join(", ")} came from a mock provider, not from ` +
        `measurement. This report is for testing and demonstration only and must not be used ` +
        `to price a fixture, support a claim, or inform a credit decision.`
    );
  }

  for (const [dimension, p] of Object.entries(provenance)) {
    const prov = p as DataProvenance;
    if (prov.unavailableReason) {
      caveats.push(`${dimension}: ${prov.unavailableReason}`);
    }
    if (prov.source === "assumption") {
      caveats.push(
        `${dimension} is an assumption you supplied (${prov.label}), not an observation. ` +
          `The distribution is only as good as that input.`
      );
    }
  }

  return caveats;
}
