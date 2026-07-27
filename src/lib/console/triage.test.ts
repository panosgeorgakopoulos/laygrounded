import { describe, expect, test } from "bun:test";
import { triageBook, triageClaim, type TriageClaimInput } from "./triage";
import type { TimeBarStatus } from "@/lib/time-bar";

function timeBar(over: Partial<TimeBarStatus> = {}): TimeBarStatus {
  return {
    timeBarDays: 90,
    anchorEventAt: "2026-06-01T00:00:00Z",
    deadline: "2026-08-30T00:00:00Z",
    daysRemaining: 40,
    state: "ok",
    completeness: [
      { key: "sof", label: "SoF document", ok: true },
      { key: "cp", label: "CP terms", ok: true },
    ],
    complete: true,
    ...over,
  };
}

function claim(over: Partial<TriageClaimInput> = {}): TriageClaimInput {
  return {
    claimId: "c1",
    vessel: "MV TEST",
    voyageRef: "V-1",
    port: "Rotterdam",
    status: "demurrage",
    timeBar: timeBar(),
    netAmount: 10_000,
    currency: "USD",
    hasCalculation: true,
    openAlerts: 0,
    pendingProposals: 0,
    suggestedEvents: 0,
    evidenceChecks: 2,
    settled: false,
    ...over,
  };
}

describe("triageClaim", () => {
  test("a settled claim produces no work", () => {
    expect(
      triageClaim(claim({ settled: true, openAlerts: 3, pendingProposals: 2 })),
    ).toEqual([]);
  });

  test("critical time bar is raised with the missing pack items named", () => {
    const actions = triageClaim(
      claim({
        timeBar: timeBar({
          state: "critical",
          daysRemaining: 5,
          complete: false,
          completeness: [
            { key: "sof", label: "SoF document", ok: false },
            { key: "cp", label: "CP terms", ok: true },
          ],
        }),
      }),
    );
    const tb = actions.find((a) => a.reason === "TIME_BAR_EXPIRING")!;
    expect(tb.severity).toBe("critical");
    expect(tb.headline).toBe("Time bar in 5 days");
    expect(tb.detail).toContain("SoF document");
    expect(tb.detail).not.toContain("CP terms");
  });

  test("singular day is not pluralised", () => {
    const actions = triageClaim(
      claim({ timeBar: timeBar({ state: "critical", daysRemaining: 1 }) }),
    );
    expect(actions[0].headline).toBe("Time bar in 1 day");
  });

  test("an expired bar stays visible but ranks lowest", () => {
    const actions = triageClaim(
      claim({ timeBar: timeBar({ state: "expired", daysRemaining: -3 }) }),
    );
    const tb = actions.find((a) => a.reason === "TIME_BAR_EXPIRED")!;
    expect(tb.severity).toBe("low");
  });

  test("no_anchor time bar raises nothing about deadlines", () => {
    const actions = triageClaim(
      claim({ timeBar: timeBar({ state: "no_anchor", daysRemaining: null }) }),
    );
    expect(actions.some((a) => a.reason.startsWith("TIME_BAR"))).toBe(false);
  });

  test("shield alerts and pending proposals each raise an action", () => {
    const actions = triageClaim(claim({ openAlerts: 2, pendingProposals: 1 }));
    expect(actions.find((a) => a.reason === "SHIELD_ALERT")!.headline).toBe(
      "2 open Legal Shield alerts",
    );
    expect(actions.find((a) => a.reason === "PROPOSAL_PENDING")!.headline).toBe(
      "1 counterparty amendment awaiting review",
    );
  });

  test("an uncomputed claim asks for a calculation, not for evidence", () => {
    const actions = triageClaim(claim({ hasCalculation: false, evidenceChecks: 0 }));
    expect(actions.some((a) => a.reason === "NO_CALCULATION")).toBe(true);
    expect(actions.some((a) => a.reason === "EVIDENCE_UNVERIFIED")).toBe(false);
    expect(actions.some((a) => a.reason === "SETTLEMENT_READY")).toBe(false);
  });

  test("unverified evidence is only raised on a claim actually claiming money", () => {
    expect(
      triageClaim(claim({ evidenceChecks: 0, netAmount: 5_000 })).some(
        (a) => a.reason === "EVIDENCE_UNVERIFIED",
      ),
    ).toBe(true);
    expect(
      triageClaim(claim({ evidenceChecks: 0, netAmount: -5_000, status: "despatch" })).some(
        (a) => a.reason === "EVIDENCE_UNVERIFIED",
      ),
    ).toBe(false);
  });

  test("actions carry a workspace link", () => {
    expect(triageClaim(claim({ claimId: "abc" }))[0].href).toBe("/claims/abc/workspace");
  });
});

describe("triageBook ranking", () => {
  test("an expiring small claim outranks a comfortable large one", () => {
    const { actions } = triageBook([
      claim({ claimId: "big", netAmount: 500_000, timeBar: timeBar({ state: "ok" }) }),
      claim({
        claimId: "urgent",
        netAmount: 900,
        timeBar: timeBar({ state: "critical", daysRemaining: 2 }),
      }),
    ]);
    expect(actions[0].claimId).toBe("urgent");
    expect(actions[0].reason).toBe("TIME_BAR_EXPIRING");
  });

  test("within one severity tier, money decides", () => {
    const { actions } = triageBook([
      claim({ claimId: "small", netAmount: 1_000, openAlerts: 1, timeBar: null }),
      claim({ claimId: "large", netAmount: 90_000, openAlerts: 1, timeBar: null }),
    ]);
    const alerts = actions.filter((a) => a.reason === "SHIELD_ALERT");
    expect(alerts.map((a) => a.claimId)).toEqual(["large", "small"]);
  });

  test("ordering is stable for identical claims", () => {
    const inputs = [
      claim({ claimId: "b", timeBar: null }),
      claim({ claimId: "a", timeBar: null }),
    ];
    const first = triageBook(inputs).actions.map((a) => a.claimId + a.reason);
    const second = triageBook([...inputs].reverse()).actions.map((a) => a.claimId + a.reason);
    expect(first).toEqual(second);
  });

  test("exposure counts once per claim even when it raises several actions", () => {
    const summary = triageBook([
      claim({
        claimId: "multi",
        netAmount: 10_000,
        openAlerts: 1,
        pendingProposals: 1,
        evidenceChecks: 0,
        timeBar: timeBar({ state: "critical", daysRemaining: 3 }),
      }),
    ]);
    expect(summary.actions.length).toBeGreaterThan(2);
    expect(summary.totalAtStake).toBe(10_000);
    expect(summary.claimsNeedingAction).toBe(1);
  });

  test("settled claims contribute neither actions nor exposure", () => {
    const summary = triageBook([
      claim({ claimId: "done", settled: true, netAmount: 80_000 }),
      claim({ claimId: "live", netAmount: 5_000, timeBar: null, evidenceChecks: 1 }),
    ]);
    expect(summary.actions.every((a) => a.claimId === "live")).toBe(true);
    expect(summary.totalAtStake).toBe(5_000);
  });

  test("severity counts tally the queue", () => {
    const summary = triageBook([
      claim({ claimId: "x", timeBar: timeBar({ state: "critical", daysRemaining: 1 }) }),
      claim({ claimId: "y", timeBar: null, openAlerts: 1 }),
    ]);
    expect(summary.counts.critical).toBe(1);
    expect(summary.counts.high).toBe(1);
  });

  test("an empty book is an empty queue, not an error", () => {
    const summary = triageBook([]);
    expect(summary.actions).toEqual([]);
    expect(summary.totalAtStake).toBe(0);
    expect(summary.currency).toBe("USD");
  });

  test("the majority currency labels the total", () => {
    const summary = triageBook([
      claim({ claimId: "a", currency: "EUR", timeBar: null }),
      claim({ claimId: "b", currency: "EUR", timeBar: null }),
      claim({ claimId: "c", currency: "USD", timeBar: null }),
    ]);
    expect(summary.currency).toBe("EUR");
  });
});
