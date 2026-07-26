import { describe, expect, test } from "bun:test";
import {
  buildCongestionCells,
  summarizePorts,
  MIN_VOYAGES,
  MIN_COMPANIES,
  type CongestionSample,
} from "./congestion";

/** n voyages at one port/month, spread across `companies` distinct tenants. */
function samples(
  n: number,
  opts: {
    companies?: number;
    port?: string;
    year?: number;
    month?: number;
    waits?: number[];
    working?: (number | null)[];
  } = {},
): CongestionSample[] {
  const companies = opts.companies ?? MIN_COMPANIES;
  return Array.from({ length: n }, (_, i) => ({
    portKey: opts.port ?? "rotterdam",
    portLabel: opts.port ? opts.port : "Rotterdam",
    companyId: `co-${i % companies}`,
    year: opts.year ?? 2026,
    month: opts.month ?? 3,
    waitingHours: opts.waits ? opts.waits[i] : 10 + i,
    workingHours: opts.working ? opts.working[i] : 40,
  }));
}

describe("k-anonymity floors", () => {
  test("a cell below the voyage floor is suppressed with no statistics", () => {
    const [cell] = buildCongestionCells(samples(MIN_VOYAGES - 1));
    expect(cell.suppressed).toBe(true);
    expect(cell.suppressionReason).toBe("too_few_voyages");
    expect(cell.medianWaitingHours).toBeNull();
    expect(cell.p90WaitingHours).toBeNull();
    // The count itself is withheld — it is information about a named port.
    expect(cell.voyages).toBeNull();
  });

  test("enough voyages from too few companies is still suppressed", () => {
    // The case a count-only floor cannot catch: one tenant's private operating
    // data would otherwise be republished under the port's name.
    const [cell] = buildCongestionCells(samples(20, { companies: 1 }));
    expect(cell.suppressed).toBe(true);
    expect(cell.suppressionReason).toBe("too_few_companies");
    expect(cell.medianWaitingHours).toBeNull();
  });

  test("two companies is not enough — each could subtract itself", () => {
    const [cell] = buildCongestionCells(samples(20, { companies: 2 }));
    expect(cell.suppressed).toBe(true);
    expect(cell.suppressionReason).toBe("too_few_companies");
  });

  test("a cell meeting both floors publishes", () => {
    const [cell] = buildCongestionCells(samples(MIN_VOYAGES, { companies: MIN_COMPANIES }));
    expect(cell.suppressed).toBe(false);
    expect(cell.voyages).toBe(MIN_VOYAGES);
    expect(cell.medianWaitingHours).not.toBeNull();
  });

  test("suppressed cells are retained, not dropped", () => {
    // Dropping them would imply the port had no traffic at all.
    const cells = buildCongestionCells(samples(2));
    expect(cells).toHaveLength(1);
    expect(cells[0].suppressed).toBe(true);
  });

  test("no cell ever carries a company id", () => {
    const cells = buildCongestionCells(samples(10));
    for (const cell of cells) {
      expect(JSON.stringify(cell)).not.toContain("co-");
    }
  });
});

describe("aggregation", () => {
  test("median and p90 are computed over the cell's waits", () => {
    const waits = [2, 4, 6, 8, 100];
    const [cell] = buildCongestionCells(samples(5, { waits }));
    expect(cell.medianWaitingHours).toBe(6);
    expect(cell.p90WaitingHours).toBe(63.2);
  });

  test("voyages are grouped by port and by month", () => {
    const cells = buildCongestionCells([
      ...samples(6, { port: "rotterdam", month: 3 }),
      ...samples(6, { port: "rotterdam", month: 4 }),
      ...samples(6, { port: "santos", month: 3 }),
    ]);
    expect(cells).toHaveLength(3);
    expect(cells.filter((c) => c.portKey === "rotterdam")).toHaveLength(2);
  });

  test("working hours are omitted when too few voyages report a completion", () => {
    const working = [40, null, null, null, null, null];
    const [cell] = buildCongestionCells(samples(6, { working }));
    expect(cell.suppressed).toBe(false);
    expect(cell.medianWorkingHours).toBeNull();
  });

  test("cells are ordered newest first", () => {
    const cells = buildCongestionCells([
      ...samples(6, { year: 2025, month: 12 }),
      ...samples(6, { year: 2026, month: 1 }),
    ]);
    expect(cells[0].year).toBe(2026);
  });
});

describe("port nowcast", () => {
  const port = (month: number, wait: number) =>
    samples(6, { month, waits: Array(6).fill(wait) });

  test("a materially higher latest median reads as rising", () => {
    const summary = summarizePorts(
      buildCongestionCells([...port(1, 10), ...port(2, 10), ...port(3, 30)]),
    )[0];
    expect(summary.trend).toBe("rising");
    expect(summary.changeVsPriorPct).toBe(200);
    expect(summary.latest?.medianWaitingHours).toBe(30);
  });

  test("a materially lower latest median reads as easing", () => {
    const summary = summarizePorts(
      buildCongestionCells([...port(1, 40), ...port(2, 40), ...port(3, 10)]),
    )[0];
    expect(summary.trend).toBe("easing");
  });

  test("a small move is steady, not a trend", () => {
    const summary = summarizePorts(
      buildCongestionCells([...port(1, 20), ...port(2, 20), ...port(3, 21)]),
    )[0];
    expect(summary.trend).toBe("steady");
  });

  test("a single period cannot establish a trend", () => {
    const summary = summarizePorts(buildCongestionCells(port(3, 20)))[0];
    expect(summary.trend).toBe("unknown");
    expect(summary.changeVsPriorPct).toBeNull();
  });

  test("suppressed cells never enter the trend or the history", () => {
    const summary = summarizePorts(
      buildCongestionCells([
        ...samples(2, { month: 1 }), // suppressed
        ...port(2, 10),
        ...port(3, 12),
      ]),
    )[0];
    expect(summary.history.every((c) => !c.suppressed)).toBe(true);
    expect(summary.history).toHaveLength(2);
  });

  test("a port with nothing publishable reports no figure but still appears", () => {
    const summary = summarizePorts(buildCongestionCells(samples(2)))[0];
    expect(summary.latest).toBeNull();
    expect(summary.history).toEqual([]);
    expect(summary.trend).toBe("unknown");
  });

  test("ports are ranked by current waiting time, unpublishable ones last", () => {
    const summaries = summarizePorts(
      buildCongestionCells([
        ...samples(6, { port: "quiet", month: 3, waits: Array(6).fill(4) }),
        ...samples(6, { port: "busy", month: 3, waits: Array(6).fill(48) }),
        ...samples(2, { port: "unknown-port", month: 3 }),
      ]),
    );
    expect(summaries.map((s) => s.portKey)).toEqual(["busy", "quiet", "unknown-port"]);
  });

  test("an empty book produces no ports rather than throwing", () => {
    expect(summarizePorts(buildCongestionCells([]))).toEqual([]);
  });
});
