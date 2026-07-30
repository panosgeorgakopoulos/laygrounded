import { describe, expect, test } from "bun:test";
import type { CpTerms } from "@/lib/laytime/types";
import { simulate } from "@/lib/risk/simulate";
import type { StoppageTrajectory, TrialInputs } from "@/lib/risk/trial";
import { makeRng } from "@/lib/risk/prng";

// The properties that have to hold for a risk figure to be worth publishing:
// it reproduces, it converges, and it moves in the right direction when the
// world gets worse.

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

/** Deterministic synthetic trajectories with a controllable storm rate. */
function makeTrajectories(
  kind: "ensemble" | "climatology",
  count: number,
  stormRate: number,
  seed: string
): StoppageTrajectory[] {
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`${seed}:${i}`);
    const flags: boolean[] = [];
    let stormHoursLeft = 0;
    for (let h = 0; h < 400; h++) {
      // Storms arrive in blocks, so the synthetic weather is autocorrelated
      // like the real thing — independent hourly flags would make the whole
      // simulation optimistic and this fixture would not exercise the tail.
      if (stormHoursLeft > 0) {
        flags.push(true);
        stormHoursLeft--;
      } else if (rng.next() < stormRate) {
        stormHoursLeft = 4 + Math.floor(rng.next() * 12);
        flags.push(true);
        stormHoursLeft--;
      } else {
        flags.push(false);
      }
    }
    return { kind, id: `${kind}-${i}`, flags };
  });
}

function baseInputs(overrides: Partial<TrialInputs> = {}): TrialInputs {
  return {
    cpTerms: CP_TERMS,
    opsDurationHours: 72,
    berthToOpsHours: 1,
    referenceStartISO: "2026-08-01T00:00:00.000Z",
    etaISO: "2026-08-01T06:00:00.000Z",
    etaErrorHours: { min: -12, mode: 0, max: 48 },
    waitingHoursSorted: [0, 2, 4, 6, 12, 18, 24, 48],
    ensemblePool: makeTrajectories("ensemble", 30, 0.02, "ens"),
    climatologyPool: makeTrajectories("climatology", 8, 0.02, "clim"),
    ensembleWeight: 1,
    ...overrides,
  };
}

describe("reproducibility", () => {
  test("the same seed and inputs reproduce the distribution exactly", () => {
    const inputs = baseInputs();
    const a = simulate(inputs, { seed: "audit-seed", trials: 2000 });
    const b = simulate(inputs, { seed: "audit-seed", trials: 2000 });
    // Deep equality on the whole distribution: this IS the audit claim.
    expect(JSON.stringify(a.distribution)).toBe(JSON.stringify(b.distribution));
  });

  test("a different seed gives a different sample but a similar answer", () => {
    const inputs = baseInputs();
    const a = simulate(inputs, { seed: "seed-a", trials: 4000 });
    const b = simulate(inputs, { seed: "seed-b", trials: 4000 });

    expect(a.distribution.expectedExposure.value).not.toBe(
      b.distribution.expectedExposure.value
    );
    // But they must agree within Monte Carlo error, or the estimator is biased
    // by the seed — which would make the seed a hidden input to the answer.
    const se = Math.hypot(
      a.distribution.expectedExposure.standardError,
      b.distribution.expectedExposure.standardError
    );
    const gap = Math.abs(
      a.distribution.expectedExposure.value - b.distribution.expectedExposure.value
    );
    expect(gap).toBeLessThan(4 * se + 1);
  });
});

describe("convergence", () => {
  test("the standard error shrinks roughly as 1/sqrt(n)", () => {
    const inputs = baseInputs();
    const small = simulate(inputs, { seed: "conv", trials: 500, antithetic: false });
    const large = simulate(inputs, { seed: "conv", trials: 8000, antithetic: false });

    const ratio =
      small.distribution.expectedExposure.standardError /
      large.distribution.expectedExposure.standardError;
    // 16x the trials should be ~4x tighter. Generous band: this is a
    // statistical property, not an identity.
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(6);
  });

  test("the estimate stabilises as trials grow", () => {
    const inputs = baseInputs();
    const runs = [2000, 4000, 8000, 16000].map(
      (n) => simulate(inputs, { seed: "stability", trials: n }).distribution.expectedExposure.value
    );
    // Each successive refinement should move the answer less than the last.
    const deltas = runs.slice(1).map((v, i) => Math.abs(v - runs[i]));
    expect(deltas[deltas.length - 1]).toBeLessThanOrEqual(deltas[0] + 1e-9);
  });

  test("the reported CI actually brackets a long-run reference", () => {
    // The honesty check on our own error bars: a 95% interval that does not
    // contain the converged answer is worse than no interval at all.
    const inputs = baseInputs();
    const reference = simulate(inputs, { seed: "ref", trials: 40000 }).distribution
      .expectedExposure.value;

    let covered = 0;
    const attempts = 20;
    for (let i = 0; i < attempts; i++) {
      const run = simulate(inputs, { seed: `cov-${i}`, trials: 2000 });
      const [lo, hi] = run.distribution.expectedExposure.ci95;
      if (reference >= lo && reference <= hi) covered++;
    }
    // Expect ~19/20; require at least 15 so the test cannot flake on noise.
    expect(covered).toBeGreaterThanOrEqual(15);
  });
});

describe("antithetic variates", () => {
  test("reduce the variance of the mean without moving it", () => {
    const inputs = baseInputs();
    const plain = simulate(inputs, { seed: "anti", trials: 4000, antithetic: false });
    const anti = simulate(inputs, { seed: "anti", trials: 4000, antithetic: true });

    expect(anti.distribution.expectedExposure.standardError).toBeLessThan(
      plain.distribution.expectedExposure.standardError
    );
    // Unbiased: the two means must agree within their combined error.
    const se = Math.hypot(
      plain.distribution.expectedExposure.standardError,
      anti.distribution.expectedExposure.standardError
    );
    expect(
      Math.abs(
        plain.distribution.expectedExposure.value - anti.distribution.expectedExposure.value
      )
    ).toBeLessThan(4 * se + 1);
  });

  test("honour an odd trial count exactly", () => {
    const run = simulate(baseInputs(), { seed: "odd", trials: 1001 });
    expect(run.trials).toBe(1001);
  });
});

describe("directional sanity", () => {
  test("more storms means more demurrage", () => {
    const calm = simulate(
      baseInputs({
        ensemblePool: makeTrajectories("ensemble", 30, 0.005, "calm"),
      }),
      { seed: "dir", trials: 3000 }
    );
    const stormy = simulate(
      baseInputs({
        ensemblePool: makeTrajectories("ensemble", 30, 0.09, "storm"),
      }),
      { seed: "dir", trials: 3000 }
    );
    expect(stormy.distribution.demurrageProbability.value).toBeGreaterThan(
      calm.distribution.demurrageProbability.value
    );
    expect(stormy.distribution.expectedExposure.value).toBeGreaterThan(
      calm.distribution.expectedExposure.value
    );
  });

  test("a longer queue means more demurrage", () => {
    const quiet = simulate(baseInputs({ waitingHoursSorted: [0, 0, 1, 1, 2, 2, 3, 4] }), {
      seed: "queue",
      trials: 3000,
    });
    const congested = simulate(
      baseInputs({ waitingHoursSorted: [24, 36, 48, 60, 72, 96, 120, 168] }),
      { seed: "queue", trials: 3000 }
    );
    expect(congested.distribution.expectedExposure.value).toBeGreaterThan(
      quiet.distribution.expectedExposure.value
    );
  });

  test("more allowed laytime means less demurrage", () => {
    const tight = simulate(
      baseInputs({ cpTerms: { ...CP_TERMS, laytime_allowed_hours: 48 } as CpTerms }),
      { seed: "cp", trials: 3000 }
    );
    const generous = simulate(
      baseInputs({ cpTerms: { ...CP_TERMS, laytime_allowed_hours: 240 } as CpTerms }),
      { seed: "cp", trials: 3000 }
    );
    expect(generous.distribution.demurrageProbability.value).toBeLessThan(
      tight.distribution.demurrageProbability.value
    );
  });
});

describe("the horizon blend is realised in the trials", () => {
  test("weight 1 draws only ensemble members", () => {
    const run = simulate(baseInputs({ ensembleWeight: 1 }), { seed: "mix", trials: 1000 });
    expect(run.distribution.trajectoryMix.climatology).toBe(0);
    expect(run.distribution.trajectoryMix.ensemble).toBe(1000);
  });

  test("weight 0 draws only historical years", () => {
    const run = simulate(baseInputs({ ensembleWeight: 0 }), { seed: "mix", trials: 1000 });
    expect(run.distribution.trajectoryMix.ensemble).toBe(0);
    expect(run.distribution.trajectoryMix.climatology).toBe(1000);
  });

  test("an intermediate weight splits trials in about that proportion", () => {
    const run = simulate(baseInputs({ ensembleWeight: 0.25 }), { seed: "mix", trials: 4000 });
    const share = run.distribution.trajectoryMix.ensemble / run.trials;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });

  test("an empty ensemble pool falls back rather than simulating no weather", () => {
    const run = simulate(baseInputs({ ensemblePool: [], ensembleWeight: 1 }), {
      seed: "fallback",
      trials: 500,
    });
    expect(run.distribution.trajectoryMix.climatology).toBe(500);
  });
});

describe("refusals", () => {
  test("no trajectories at all is an error, not an empty distribution", () => {
    expect(() =>
      simulate(baseInputs({ ensemblePool: [], climatologyPool: [] }), { seed: "x" })
    ).toThrow("NO_WEATHER_TRAJECTORIES");
  });

  test("no congestion samples is an error, not a free berth", () => {
    expect(() =>
      simulate(baseInputs({ waitingHoursSorted: [] }), { seed: "x" })
    ).toThrow("NO_CONGESTION_SAMPLES");
  });
});
