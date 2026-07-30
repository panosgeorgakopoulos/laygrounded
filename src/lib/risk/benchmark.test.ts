import { describe, expect, test } from "bun:test";
import type { CpTerms } from "@/lib/laytime/types";
import { simulate, DEFAULT_TRIALS, MAX_TRIALS } from "@/lib/risk/simulate";
import type { StoppageTrajectory, TrialInputs } from "@/lib/risk/trial";
import { makeRng } from "@/lib/risk/prng";

// Whether the route can answer synchronously is an engineering claim, so it is
// measured rather than assumed. If the default trial count stops fitting inside
// a request, this test fails and the answer is a job queue — not a quietly
// slower endpoint.
//
// Thresholds are deliberately loose: CI machines are slower and noisier than a
// laptop, and a benchmark that flakes gets deleted, which is worse than one
// that only catches large regressions.

const CP_TERMS: CpTerms = {
  laytime_allowed_hours: 72,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24000,
  despatch_rate: 12000,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
} as CpTerms;

function trajectories(kind: "ensemble" | "climatology", count: number): StoppageTrajectory[] {
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`bench-${kind}-${i}`);
    const flags: boolean[] = [];
    let storm = 0;
    for (let h = 0; h < 400; h++) {
      if (storm > 0) {
        flags.push(true);
        storm--;
      } else if (rng.next() < 0.03) {
        storm = 4 + Math.floor(rng.next() * 10);
        flags.push(true);
        storm--;
      } else flags.push(false);
    }
    return { kind, id: `${kind}${i}`, flags };
  });
}

/** A realistically-sized workload: 30 GFS members, 8 historical years. */
const INPUTS: TrialInputs = {
  cpTerms: CP_TERMS,
  opsDurationHours: 96,
  berthToOpsHours: 1,
  referenceStartISO: "2026-08-01T00:00:00.000Z",
  etaISO: "2026-08-01T06:00:00.000Z",
  etaErrorHours: { min: -12, mode: 0, max: 48 },
  waitingHoursSorted: [0, 2, 4, 8, 12, 24, 36, 72],
  ensemblePool: trajectories("ensemble", 30),
  climatologyPool: trajectories("climatology", 8),
  ensembleWeight: 0.6,
};

describe("performance", () => {
  test(`the default ${DEFAULT_TRIALS} trials fit comfortably in a request`, () => {
    const started = performance.now();
    const run = simulate(INPUTS, { seed: "bench", trials: DEFAULT_TRIALS });
    const elapsed = performance.now() - started;

    expect(run.trials).toBe(DEFAULT_TRIALS);
    // 5s is the ceiling for a synchronous route; a healthy machine is far
    // under it. Crossing this means moving to a background job.
    expect(elapsed).toBeLessThan(5000);
    console.log(
      `      ${DEFAULT_TRIALS} trials in ${elapsed.toFixed(0)}ms ` +
        `(${((elapsed / DEFAULT_TRIALS) * 1000).toFixed(1)}µs/trial)`
    );
  });

  test("cost scales roughly linearly in the trial count", () => {
    const time = (n: number) => {
      const t = performance.now();
      simulate(INPUTS, { seed: "scale", trials: n });
      return performance.now() - t;
    };
    time(500); // warm up, so JIT compilation is not charged to the first sample
    const small = time(1000);
    const large = time(4000);
    // 4x the work should cost well under 10x the time. Anything superlinear
    // means an accidental O(n²) — a per-trial copy of the trajectory pool, say.
    expect(large / Math.max(small, 0.01)).toBeLessThan(10);
    console.log(`      1k=${small.toFixed(0)}ms  4k=${large.toFixed(0)}ms`);
  });

  test(`the ${MAX_TRIALS}-trial ceiling stays bounded`, () => {
    const started = performance.now();
    simulate(INPUTS, { seed: "ceiling", trials: MAX_TRIALS });
    const elapsed = performance.now() - started;
    // The documented maximum must remain something a caller can actually ask
    // for, even if it is not the default.
    expect(elapsed).toBeLessThan(45_000);
    console.log(`      ${MAX_TRIALS} trials in ${(elapsed / 1000).toFixed(1)}s`);
  });

  test("memory stays flat: trials are aggregated, not accumulated wholesale", () => {
    // Guards against retaining per-trial timelines, which at 50k trials would
    // be hundreds of megabytes.
    const before = process.memoryUsage().heapUsed;
    simulate(INPUTS, { seed: "mem", trials: 20000 });
    const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(growthMb).toBeLessThan(200);
    console.log(`      heap growth over 20k trials: ${growthMb.toFixed(1)}MB`);
  });
});
