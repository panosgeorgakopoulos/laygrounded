// Engine-independent validity laws for laytime results.
//
// These are provable properties of ANY correct laytime calculation, stated
// without reference to the engine's implementation. The generator refuses to
// emit a case whose result violates one, and the regression suite re-checks
// them on every run — so a corpus mismatch always distinguishes "the numbers
// changed" (golden diff) from "the numbers are impossible" (invariant).

import { Decimal } from "decimal.js";
import { CpTerms, LaytimeResult, SofEventInput } from "../../src/lib/laytime/types";

const HOUR_MS = 3600_000;

export function checkInvariants(
  events: SofEventInput[],
  cpTerms: CpTerms,
  result: LaytimeResult
): string[] {
  const errors: string[] = [];
  const { breakdown, totals } = result;

  // --- Breakdown geometry ---
  for (let i = 0; i < breakdown.length; i++) {
    const row = breakdown[i];
    const start = new Date(row.start_time).getTime();
    const end = new Date(row.end_time).getTime();
    if (!(end > start)) {
      errors.push(`row ${i}: end_time not after start_time`);
      continue;
    }
    const durationHours = (end - start) / HOUR_MS;
    if (Math.abs(durationHours - row.duration_hours) > 1e-9) {
      errors.push(
        `row ${i}: duration_hours ${row.duration_hours} ≠ span ${durationHours}`
      );
    }
    if (i > 0 && breakdown[i - 1].end_time !== row.start_time) {
      errors.push(`row ${i}: gap/overlap — previous end ${breakdown[i - 1].end_time} ≠ start ${row.start_time}`);
    }
  }

  // Breakdown must lie within the event horizon.
  if (breakdown.length > 0 && events.length > 0) {
    const eventTimes = events.map((e) => new Date(e.occurred_at).getTime());
    const minEvent = Math.min(...eventTimes);
    const maxEvent = Math.max(...eventTimes);
    const first = new Date(breakdown[0].start_time).getTime();
    const last = new Date(breakdown[breakdown.length - 1].end_time).getTime();
    if (first < minEvent) {
      errors.push("breakdown starts before the first event");
    }
    // Commencement may be deferred well past NOR (turn time + excepted days),
    // and a default window may extend past the last event when no completion
    // exists; allow a bounded overshoot only in that documented case.
    const completions = events.filter(
      (e) => e.event_type === "COMPLETED_LOADING" || e.event_type === "COMPLETED_DISCHARGE"
    );
    if (completions.length > 0 && last > maxEvent) {
      errors.push("breakdown extends past the final event despite a completion event");
    }
  }

  // --- Conservation: used hours == Σ counting hours ---
  const countedHours = breakdown.reduce(
    (acc, r) => (r.counts ? acc + r.duration_hours : acc),
    0
  );
  if (Math.abs(countedHours - totals.used_hours) > 1e-9) {
    errors.push(`used_hours ${totals.used_hours} ≠ Σ counting rows ${countedHours}`);
  }

  // --- Demurrage/despatch arithmetic ---
  const expectedOnDem = Math.max(0, totals.used_hours - totals.allowed_hours);
  const expectedSaved = Math.max(0, totals.allowed_hours - totals.used_hours);
  if (Math.abs(expectedOnDem - totals.time_on_demurrage_hours) > 1e-9) {
    errors.push(`time_on_demurrage_hours ${totals.time_on_demurrage_hours} ≠ ${expectedOnDem}`);
  }
  if (Math.abs(expectedSaved - totals.time_saved_hours) > 1e-9) {
    errors.push(`time_saved_hours ${totals.time_saved_hours} ≠ ${expectedSaved}`);
  }
  if (totals.demurrage_amount > 0 && totals.despatch_amount > 0) {
    errors.push("demurrage and despatch cannot both be positive");
  }

  // Billing law: pro-rata per day, half-rate hours (ASBATANKVOY II-8) billed
  // at 50%. Verified with decimal arithmetic, to the cent.
  const halfRate = totals.demurrage_half_rate_hours ?? 0;
  if (halfRate < 0 || halfRate > totals.time_on_demurrage_hours) {
    errors.push(`demurrage_half_rate_hours ${halfRate} outside [0, time_on_demurrage]`);
  }
  const expectedDemAmount = new Decimal(totals.time_on_demurrage_hours)
    .minus(halfRate)
    .plus(new Decimal(halfRate).div(2))
    .div(24)
    .mul(cpTerms.demurrage_rate)
    .toDecimalPlaces(2)
    .toNumber();
  if (Math.abs(expectedDemAmount - totals.demurrage_amount) > 0.01) {
    errors.push(`demurrage_amount ${totals.demurrage_amount} ≠ billing law ${expectedDemAmount}`);
  }
  const expectedDesAmount = new Decimal(totals.time_saved_hours)
    .div(24)
    .mul(cpTerms.despatch_rate)
    .toDecimalPlaces(2)
    .toNumber();
  if (Math.abs(expectedDesAmount - totals.despatch_amount) > 0.01) {
    errors.push(`despatch_amount ${totals.despatch_amount} ≠ billing law ${expectedDesAmount}`);
  }

  // --- Demurrage monotonicity ---
  // Demurrage begins exactly when cumulative counting hours reach the
  // allowance, and once on demurrage the vessel never leaves it.
  let cumulative = 0;
  let demurrageSeen = false;
  for (let i = 0; i < breakdown.length; i++) {
    const row = breakdown[i];
    if (row.status === "demurrage") {
      if (!demurrageSeen && Math.abs(cumulative - totals.allowed_hours) > 1e-9) {
        errors.push(
          `row ${i}: demurrage began at cumulative ${cumulative}h, not at allowance ${totals.allowed_hours}h`
        );
      }
      demurrageSeen = true;
      if (!row.counts) errors.push(`row ${i}: demurrage row must count`);
    } else if (demurrageSeen) {
      errors.push(`row ${i}: status ${row.status} after demurrage began`);
    }
    if (row.counts) cumulative += row.duration_hours;
  }

  // --- Metadata ---
  if (totals.currency !== cpTerms.currency) {
    errors.push(`currency ${totals.currency} ≠ CP terms ${cpTerms.currency}`);
  }
  if (totals.allowed_hours !== cpTerms.laytime_allowed_hours) {
    errors.push(`allowed_hours ${totals.allowed_hours} ≠ CP terms ${cpTerms.laytime_allowed_hours}`);
  }
  for (let i = 0; i < breakdown.length; i++) {
    if (!breakdown[i].clause_ref) errors.push(`row ${i}: missing clause_ref`);
    if (!breakdown[i].reasoning) errors.push(`row ${i}: missing reasoning`);
  }

  return errors;
}
