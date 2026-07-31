// Hinterland notification decisions.
//
// A notification tells a third party to re-plan real trucks and trains, so a
// false positive costs a customer money just as a miss does. These tests pin
// the two refusals that matter most: never fire on a statistic we do not have,
// and never fire on a forecast we would not trust ourselves.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELAY_THRESHOLD_HOURS,
  buildDelayPayload,
  buildStoppagePayload,
  decideDelayNotification,
  decideStoppageNotification,
  isHinterlandEvent,
  thresholdFor,
  type RiskSnapshot,
  type StoppageSnapshot,
} from "./hinterland";

const FIRED_AT = new Date("2026-08-01T12:00:00Z");

function risk(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    riskId: "r-1",
    claimId: "c-1",
    vessel: "AEGEAN TRADER",
    voyageRef: "4201/2026",
    port: "Rotterdam",
    cargo: "Steam coal",
    etaISO: "2026-08-04T06:00:00Z",
    decisionGrade: true,
    p90WaitingHours: 30,
    p90StoppageHours: 6,
    demurrageProbability: 0.72,
    p90Exposure: 148_000,
    currency: "USD",
    ...over,
  };
}

function stoppage(over: Partial<StoppageSnapshot> = {}): StoppageSnapshot {
  return {
    claimId: "c-1",
    vessel: "IONIAN PIONEER",
    voyageRef: "12/2026",
    port: "Santos",
    cargo: "Soybeans",
    stoppageHours: 31.5,
    revisedCompletionISO: "2026-08-06T18:00:00Z",
    currency: "USD",
    demurrageAmount: 96_000,
    ...over,
  };
}

describe("delay forecast — the threshold", () => {
  test("fires when waiting + stoppage clears the threshold", () => {
    const d = decideDelayNotification(risk(), 24);
    expect(d).toEqual({ fire: true, event: "hinterland.delay_forecast", delayHours: 36 });
  });

  test("does not fire below it", () => {
    const d = decideDelayNotification(risk({ p90WaitingHours: 10, p90StoppageHours: 2 }), 24);
    expect(d).toEqual({ fire: false, reason: "below_threshold" });
  });

  test("the boundary fires (>= threshold)", () => {
    const d = decideDelayNotification(risk({ p90WaitingHours: 24, p90StoppageHours: 0 }), 24);
    expect(d.fire).toBe(true);
  });

  test("a null stoppage P90 is treated as zero, not as a blocker", () => {
    // Missing stoppage means "no stoppage recorded"; the waiting figure alone
    // is still a valid delay forecast.
    const d = decideDelayNotification(risk({ p90StoppageHours: null, p90WaitingHours: 30 }), 24);
    expect(d).toMatchObject({ fire: true, delayHours: 30 });
  });

  test("the default threshold is a working day", () => {
    expect(DEFAULT_DELAY_THRESHOLD_HOURS).toBe(24);
    expect(decideDelayNotification(risk({ p90WaitingHours: 20, p90StoppageHours: 0 })).fire).toBe(false);
    expect(decideDelayNotification(risk({ p90WaitingHours: 25, p90StoppageHours: 0 })).fire).toBe(true);
  });

  test("per-subscription thresholds change the answer for the same voyage", () => {
    const r = risk({ p90WaitingHours: 30, p90StoppageHours: 0 });
    expect(decideDelayNotification(r, 12).fire).toBe(true);
    expect(decideDelayNotification(r, 48).fire).toBe(false);
  });
});

describe("delay forecast — the refusals", () => {
  test("a missing P90 is 'cannot say', NEVER the mean", () => {
    // The single most important test in this file. A mean wait of 10h routinely
    // hides a P90 of 40h; substituting it would understate exactly the tail the
    // notification exists to warn about.
    const d = decideDelayNotification(risk({ p90WaitingHours: null }), 24);
    expect(d).toEqual({ fire: false, reason: "statistic_unavailable" });
  });

  test("NaN and Infinity are treated as unavailable, not as huge delays", () => {
    expect(decideDelayNotification(risk({ p90WaitingHours: NaN })).fire).toBe(false);
    expect(decideDelayNotification(risk({ p90WaitingHours: Infinity })).fire).toBe(false);
  });

  test("a non-decision-grade forecast never fires, however large", () => {
    // decisionGrade is false when any input was mock or synthetic. Re-planning
    // a rail slot on synthetic congestion is worse than not calling.
    const d = decideDelayNotification(risk({ decisionGrade: false, p90WaitingHours: 500 }), 24);
    expect(d).toEqual({ fire: false, reason: "not_decision_grade" });
  });

  test("distrust outranks size in the reported reason", () => {
    const d = decideDelayNotification(
      risk({ decisionGrade: false, p90WaitingHours: null }),
      24
    );
    expect(d).toMatchObject({ reason: "not_decision_grade" });
  });
});

describe("observed stoppage", () => {
  test("fires above the threshold", () => {
    expect(decideStoppageNotification(stoppage(), 24)).toEqual({
      fire: true,
      event: "hinterland.stoppage",
      stoppageHours: 31.5,
    });
  });

  test("zero stoppage is 'no_stoppage', distinct from 'below_threshold'", () => {
    // The two mean different things operationally: nothing happened, versus
    // something happened but not enough to re-plan around.
    expect(decideStoppageNotification(stoppage({ stoppageHours: 0 }), 24).fire).toBe(false);
    expect(decideStoppageNotification(stoppage({ stoppageHours: 0 }), 24)).toMatchObject({
      reason: "no_stoppage",
    });
    expect(decideStoppageNotification(stoppage({ stoppageHours: 5 }), 24)).toMatchObject({
      reason: "below_threshold",
    });
  });
});

describe("per-subscription threshold config", () => {
  test("reads a configured override", () => {
    expect(thresholdFor({ hinterland_delay_threshold_hours: 12 })).toBe(12);
    expect(thresholdFor({ hinterland_delay_threshold_hours: "36" })).toBe(36);
  });

  const rejected = [
    { name: "zero (would notify on every voyage)", cfg: { hinterland_delay_threshold_hours: 0 } },
    { name: "negative", cfg: { hinterland_delay_threshold_hours: -5 } },
    { name: "NaN", cfg: { hinterland_delay_threshold_hours: NaN } },
    { name: "non-numeric string", cfg: { hinterland_delay_threshold_hours: "soon" } },
    { name: "wrong key", cfg: { threshold: 12 } },
    { name: "empty", cfg: {} },
    { name: "null", cfg: null },
  ];
  for (const c of rejected) {
    test(`falls back to the default: ${c.name}`, () => {
      // A misconfigured 0 would page the partner on every voyage and train them
      // to ignore us — the expensive failure mode.
      expect(thresholdFor(c.cfg)).toBe(DEFAULT_DELAY_THRESHOLD_HOURS);
    });
  }
});

describe("payloads are self-describing", () => {
  test("a forecast says it is a forecast, and what kind", () => {
    const p = buildDelayPayload(risk(), 36, 24, FIRED_AT);
    expect(p.basis).toBe("forecast");
    expect(p.event).toBe("hinterland.delay_forecast");
    expect(p.delayHoursP90).toBe(36);
    expect(p.thresholdHours).toBe(24);
    // A partner committing assets must not read a P90 as "the vessel is late".
    expect(p.interpretation).toContain("P90");
    expect(p.interpretation).toContain("forecast");
    expect(p.firedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  test("an observed stoppage says it already happened", () => {
    const p = buildStoppagePayload(stoppage(), 24, FIRED_AT);
    expect(p.basis).toBe("observed");
    expect(p.interpretation).toContain("already occurred");
    // States the contrast explicitly rather than merely omitting it.
    expect(p.interpretation).toContain("not a forecast");
    expect(p.stoppageHours).toBe(31.5);
  });

  test("delay hours are rounded to 2dp without producing -0", () => {
    const p = buildDelayPayload(risk(), 36.123456, 24, FIRED_AT);
    expect(p.delayHoursP90).toBe(36.12);
    expect(Object.is(buildDelayPayload(risk(), 0, 24, FIRED_AT).delayHoursP90, -0)).toBe(false);
  });

  test("nulls survive rather than becoming zero", () => {
    const p = buildDelayPayload(
      risk({ p90Exposure: null, currency: null, claimId: null, etaISO: null }),
      36,
      24,
      FIRED_AT
    );
    expect(p.marineExposureP90).toBeNull();
    expect(p.currency).toBeNull();
    expect(p.claimId).toBeNull();
    expect(p.etaISO).toBeNull();
  });

  test("event names are recognised by the guard", () => {
    expect(isHinterlandEvent("hinterland.delay_forecast")).toBe(true);
    expect(isHinterlandEvent("hinterland.stoppage")).toBe(true);
    expect(isHinterlandEvent("time_bar.warning")).toBe(false);
    expect(isHinterlandEvent("hinterland.anything_else")).toBe(false);
  });
});
