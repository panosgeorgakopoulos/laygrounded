import { describe, expect, test } from "bun:test";
import {
  evaluateProtectiveNotice,
  DEFAULT_NOTICE_LEAD_DAYS,
  type NoticeVerdict,
} from "./protective-notice";
import { computeTimeBar, type TimeBarStatus } from "@/lib/time-bar";

function timeBar(over: Partial<TimeBarStatus> = {}): TimeBarStatus {
  return {
    timeBarDays: 90,
    anchorEventAt: "2026-05-01T00:00:00Z",
    deadline: "2026-07-30T00:00:00Z",
    daysRemaining: 10,
    state: "warning",
    completeness: [
      { key: "sof_document", label: "Statement of Facts uploaded", ok: true },
      { key: "nor_event", label: "NOR tendered event confirmed", ok: true },
      { key: "completion_event", label: "Completion of cargo operations confirmed", ok: true },
      { key: "cp_terms", label: "CP terms complete and valid", ok: true },
      { key: "calculation", label: "Laytime calculation computed", ok: true },
    ],
    complete: true,
    ...over,
  };
}

describe("evaluateProtectiveNotice — verdicts", () => {
  const cases: Array<{ name: string; input: Parameters<typeof evaluateProtectiveNotice>[0]; verdict: NoticeVerdict; due: boolean }> = [
    {
      name: "inside the lead window with an incomplete pack",
      input: {
        timeBar: timeBar({
          daysRemaining: 10,
          complete: false,
          completeness: [
            { key: "sof_document", label: "Statement of Facts uploaded", ok: false },
            { key: "calculation", label: "Laytime calculation computed", ok: false },
          ],
        }),
        alreadyFiled: false,
        settled: false,
      },
      verdict: "due",
      due: true,
    },
    {
      name: "inside the lead window with a complete pack still warrants a notice",
      input: { timeBar: timeBar({ daysRemaining: 3 }), alreadyFiled: false, settled: false },
      verdict: "due",
      due: true,
    },
    {
      name: "outside the lead window",
      input: { timeBar: timeBar({ daysRemaining: 45, state: "ok" }), alreadyFiled: false, settled: false },
      verdict: "not_yet",
      due: false,
    },
    {
      name: "no completion event means no clock",
      input: {
        timeBar: timeBar({ state: "no_anchor", daysRemaining: null, deadline: null, anchorEventAt: null }),
        alreadyFiled: false,
        settled: false,
      },
      verdict: "no_deadline",
      due: false,
    },
    {
      name: "already expired",
      input: { timeBar: timeBar({ daysRemaining: -4, state: "expired" }), alreadyFiled: false, settled: false },
      verdict: "expired",
      due: false,
    },
    {
      name: "already filed",
      input: { timeBar: timeBar({ daysRemaining: 2 }), alreadyFiled: true, settled: false },
      verdict: "already_filed",
      due: false,
    },
    {
      name: "settled claims need nothing preserved",
      input: { timeBar: timeBar({ daysRemaining: 2 }), alreadyFiled: false, settled: true },
      verdict: "settled",
      due: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const d = evaluateProtectiveNotice(c.input);
      expect(d.verdict).toBe(c.verdict);
      expect(d.due).toBe(c.due);
    });
  }
});

describe("evaluateProtectiveNotice — boundaries and precedence", () => {
  test("exactly at the lead boundary is due", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: DEFAULT_NOTICE_LEAD_DAYS }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.due).toBe(true);
  });

  test("one day outside the boundary is not", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: DEFAULT_NOTICE_LEAD_DAYS + 1 }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.due).toBe(false);
  });

  test("day zero — the deadline is today — is still due, not expired", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: 0, state: "critical" }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.verdict).toBe("due");
  });

  test("a custom lead window is honoured", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: 25 }),
      alreadyFiled: false,
      settled: false,
      leadDays: 30,
    });
    expect(d.due).toBe(true);
  });

  test("settled outranks everything, including an expired bar", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: -10, state: "expired" }),
      alreadyFiled: false,
      settled: true,
    });
    expect(d.verdict).toBe("settled");
  });

  test("already filed outranks the deadline so a re-sweep cannot double-file", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: 1, state: "critical" }),
      alreadyFiled: true,
      settled: false,
    });
    expect(d.verdict).toBe("already_filed");
    expect(d.due).toBe(false);
  });
});

describe("evaluateProtectiveNotice — reporting", () => {
  test("names every outstanding pack item so the letter can list them", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({
        daysRemaining: 5,
        complete: false,
        completeness: [
          { key: "sof_document", label: "Statement of Facts uploaded", ok: false },
          { key: "nor_event", label: "NOR tendered event confirmed", ok: true },
          { key: "calculation", label: "Laytime calculation computed", ok: false },
        ],
      }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.missing).toEqual([
      "Statement of Facts uploaded",
      "Laytime calculation computed",
    ]);
    expect(d.reason).toContain("Statement of Facts uploaded");
  });

  test("a complete pack says so rather than listing nothing", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: 5 }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.missing).toEqual([]);
    expect(d.reason).toContain("complete");
  });

  test("carries the deadline through for the letter to cite", () => {
    const d = evaluateProtectiveNotice({
      timeBar: timeBar({ daysRemaining: 5 }),
      alreadyFiled: false,
      settled: false,
    });
    expect(d.deadline).toBe("2026-07-30T00:00:00Z");
    expect(d.daysRemaining).toBe(5);
  });
});

describe("integration with computeTimeBar", () => {
  test("a real 90-day bar 8 days out is due", () => {
    const tb = computeTimeBar({
      timeBarDays: 90,
      events: [{ event_type: "COMPLETED_DISCHARGE", occurred_at: "2026-05-01T00:00:00Z" }],
      hasSofDocument: true,
      hasValidCpTerms: true,
      hasCalculation: false,
      now: new Date("2026-07-22T00:00:00Z"),
    });
    const d = evaluateProtectiveNotice({ timeBar: tb, alreadyFiled: false, settled: false });
    expect(d.verdict).toBe("due");
    expect(d.missing).toContain("Laytime calculation computed");
  });

  test("a claim with no completion event never triggers a notice", () => {
    const tb = computeTimeBar({
      timeBarDays: 90,
      events: [{ event_type: "NOR_TENDERED", occurred_at: "2026-07-01T00:00:00Z" }],
      hasSofDocument: true,
      hasValidCpTerms: true,
      hasCalculation: false,
      now: new Date("2026-07-29T00:00:00Z"),
    });
    const d = evaluateProtectiveNotice({ timeBar: tb, alreadyFiled: false, settled: false });
    expect(d.verdict).toBe("no_deadline");
  });
});
