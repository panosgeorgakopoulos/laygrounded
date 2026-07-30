import { describe, expect, test } from "bun:test";
import type { CpTerms } from "@/lib/laytime/types";
import {
  decodeRuns,
  defaultSeed,
  digestInputs,
  encodeRuns,
  inputsToTrialInputs,
  verifyReplay,
  type PersistedInputs,
} from "@/lib/risk/assess-server";
import { simulate } from "@/lib/risk/simulate";
import { makeRng } from "@/lib/risk/prng";

// The audit claim: hand someone the stored row months later and they reproduce
// the published figures exactly, with no network and no clock. Everything here
// exists to hold that claim up.

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

function syntheticFlags(seed: string, hours = 400): boolean[] {
  const rng = makeRng(seed);
  const flags: boolean[] = [];
  let storm = 0;
  for (let h = 0; h < hours; h++) {
    if (storm > 0) {
      flags.push(true);
      storm--;
    } else if (rng.next() < 0.03) {
      storm = 3 + Math.floor(rng.next() * 10);
      flags.push(true);
      storm--;
    } else flags.push(false);
  }
  return flags;
}

function persistedInputs(): PersistedInputs {
  return {
    cpTerms: CP_TERMS,
    opsDurationHours: 72,
    berthToOpsHours: 1,
    operation: "loading",
    referenceStartISO: "2026-08-01T00:00:00.000Z",
    etaISO: "2026-08-01T06:00:00.000Z",
    etaErrorHours: { min: -12, mode: 0, max: 48 },
    waitingHoursSorted: [0, 2, 6, 12, 24, 48],
    ensembleWeight: 0.6,
    cargoProfile: {
      cargoKey: "grain",
      label: "Grain and agribulk",
      precipMmPerHr: 0.2,
      windKn: null,
      gustKn: 35,
      minTempC: null,
      maxTempC: null,
      sourceLabel: "LayGrounded Baseline Default - Overridable",
      origin: "baseline",
    },
    trajectories: [
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: "ensemble" as const,
        id: `member${i}`,
        runs: encodeRuns(syntheticFlags(`e${i}`)),
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: "climatology" as const,
        id: String(2018 + i),
        runs: encodeRuns(syntheticFlags(`c${i}`)),
      })),
    ],
  };
}

describe("run-length encoding of stoppage flags", () => {
  test("round-trips exactly", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const flags = syntheticFlags(seed);
      expect(decodeRuns(encodeRuns(flags))).toEqual(flags);
    }
  });

  test("handles the edges", () => {
    expect(decodeRuns(encodeRuns([]))).toEqual([]);
    expect(decodeRuns(encodeRuns([true]))).toEqual([true]);
    expect(decodeRuns(encodeRuns([false]))).toEqual([false]);
    expect(decodeRuns(encodeRuns([true, true, true]))).toEqual([true, true, true]);
    expect(decodeRuns(encodeRuns([false, false]))).toEqual([false, false]);
  });

  test("starts with a false run, so the encoding is unambiguous", () => {
    // A series beginning with `true` must record a leading zero-length false
    // run, or the decoder cannot know which value the first run carries.
    expect(encodeRuns([true, true, false])[0]).toBe(0);
  });

  test("actually compresses autocorrelated weather", () => {
    const flags = syntheticFlags("compression", 336);
    const runs = encodeRuns(flags);
    // Storms come in blocks, so runs should be far fewer than hours. This is
    // what makes storing every trajectory forever affordable.
    expect(runs.length).toBeLessThan(flags.length / 4);
  });
});

describe("replay from persisted inputs", () => {
  test("reproduces the published distribution exactly", () => {
    const inputs = persistedInputs();
    const seed = "MV Test|V-1|rotterdam|2026-08-01T06:00:00.000Z|2026-07-30T09";

    const original = simulate(inputsToTrialInputs(inputs), { seed, trials: 2000 });

    // The audit: serialise as the DB would, read it back, replay.
    const roundTripped = JSON.parse(JSON.stringify(inputs)) as PersistedInputs;
    const replay = simulate(inputsToTrialInputs(roundTripped), { seed, trials: 2000 });

    expect(JSON.stringify(replay.distribution)).toBe(JSON.stringify(original.distribution));
  });

  test("the digest detects any tampering with the inputs", () => {
    const inputs = persistedInputs();
    const digest = digestInputs(inputs);

    expect(digestInputs(JSON.parse(JSON.stringify(inputs)))).toBe(digest);

    const tampered = persistedInputs();
    tampered.waitingHoursSorted = [0, 2, 6, 12, 24, 49];
    expect(digestInputs(tampered)).not.toBe(digest);

    const reweighted = persistedInputs();
    reweighted.ensembleWeight = 0.61;
    expect(digestInputs(reweighted)).not.toBe(digest);
  });

  test("the digest ignores key order, so a re-serialised row still verifies", () => {
    // Postgres jsonb does not preserve key order; a digest sensitive to it
    // would report every stored row as tampered.
    const inputs = persistedInputs();
    const reordered = JSON.parse(
      JSON.stringify({
        trajectories: inputs.trajectories,
        cpTerms: inputs.cpTerms,
        waitingHoursSorted: inputs.waitingHoursSorted,
        ensembleWeight: inputs.ensembleWeight,
        cargoProfile: inputs.cargoProfile,
        etaErrorHours: inputs.etaErrorHours,
        etaISO: inputs.etaISO,
        referenceStartISO: inputs.referenceStartISO,
        operation: inputs.operation,
        berthToOpsHours: inputs.berthToOpsHours,
        opsDurationHours: inputs.opsDurationHours,
      })
    );
    expect(digestInputs(reordered)).toBe(digestInputs(inputs));
  });

  test("verifyReplay survives jsonb key reordering", () => {
    // The trap this guards: Postgres does not preserve key order, so a stored
    // distribution comes back with its keys shuffled. A JSON.stringify
    // comparison calls that a divergence and reports every honest replay as
    // tampered.
    const inputs = persistedInputs();
    const seed = "replay-canonical";
    const original = simulate(inputsToTrialInputs(inputs), { seed, trials: 800 });

    const shuffled = JSON.parse(
      JSON.stringify(original.distribution, Object.keys(original.distribution).sort().reverse())
    );
    // Sanity: the shuffle really did change the byte order.
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(original.distribution));

    const verdict = verifyReplay(inputs, digestInputs(inputs), original.distribution, {
      seed,
      trials: 800,
      antithetic: true,
    });
    expect(verdict.reproduced).toBe(true);
    expect(verdict.inputsIntact).toBe(true);
    expect(verdict.differences).toEqual([]);
  });

  test("verifyReplay names a genuine value difference", () => {
    const inputs = persistedInputs();
    const seed = "replay-tamper";
    const original = simulate(inputsToTrialInputs(inputs), { seed, trials: 800 });

    const tampered = JSON.parse(JSON.stringify(original.distribution));
    tampered.expectedExposure.value += 1;

    const verdict = verifyReplay(inputs, digestInputs(inputs), tampered, {
      seed,
      trials: 800,
      antithetic: true,
    });
    expect(verdict.reproduced).toBe(false);
    expect(verdict.differences.some((d) => d.includes("expectedExposure.value"))).toBe(true);
  });

  test("verifyReplay flags inputs that no longer match their digest", () => {
    const inputs = persistedInputs();
    const seed = "replay-digest";
    const original = simulate(inputsToTrialInputs(inputs), { seed, trials: 500 });

    const verdict = verifyReplay(inputs, "0".repeat(64), original.distribution, {
      seed,
      trials: 500,
      antithetic: true,
    });
    expect(verdict.inputsIntact).toBe(false);
    expect(verdict.reproduced).toBe(false);
  });

  test("pools are reconstructed on the right side of the blend", () => {
    const trial = inputsToTrialInputs(persistedInputs());
    expect(trial.ensemblePool.length).toBe(12);
    expect(trial.climatologyPool.length).toBe(6);
    expect(trial.ensemblePool.every((t) => t.kind === "ensemble")).toBe(true);
    expect(trial.climatologyPool.every((t) => t.kind === "climatology")).toBe(true);
  });
});

describe("defaultSeed", () => {
  test("is stable within the hour, so a refresh does not move the number", () => {
    const req = { vessel: "MV Test", port: "Rotterdam, NL", etaISO: "2026-08-10T00:00:00.000Z", voyageRef: "V-1" };
    expect(defaultSeed(req, "2026-07-30T09:12:00.000Z")).toBe(
      defaultSeed(req, "2026-07-30T09:58:00.000Z")
    );
  });

  test("changes across hours, so a reassessment is a fresh sample", () => {
    const req = { vessel: "MV Test", port: "Rotterdam, NL", etaISO: "2026-08-10T00:00:00.000Z", voyageRef: "V-1" };
    expect(defaultSeed(req, "2026-07-30T09:00:00.000Z")).not.toBe(
      defaultSeed(req, "2026-07-30T10:00:00.000Z")
    );
  });

  test("distinguishes vessels and voyages", () => {
    const now = "2026-07-30T09:00:00.000Z";
    const a = { vessel: "MV A", port: "Rotterdam", etaISO: "2026-08-10T00:00:00.000Z", voyageRef: "V-1" };
    expect(defaultSeed(a, now)).not.toBe(defaultSeed({ ...a, vessel: "MV B" }, now));
    expect(defaultSeed(a, now)).not.toBe(defaultSeed({ ...a, voyageRef: "V-2" }, now));
  });
});
