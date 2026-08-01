/// <reference types="bun-types" />
// The ERP-schedule → risk-simulator bridge.
//
// The round trip is the property that matters: whatever the schedules page puts
// in, the simulator must get back. Both sides import this module precisely so
// the test below covers both.

import { describe, expect, test } from "bun:test";
import {
  buildPreArrivalQuery,
  hasPrefill,
  isoToDatetimeLocal,
  operationFromPortFunction,
  readPreArrivalPrefill,
} from "./prefill";

const SCHEDULE = {
  vessel: "MV PACIFIC CREST",
  voyageRef: "V26-041",
  port: "Santos",
  cargo: "Soybeans",
  eta: "2026-08-14T06:00:00.000Z",
  portFunction: "load",
  cargoQuantityMt: 62_000,
  externalRef: "SCH-0001",
};

describe("round trip", () => {
  test("everything the schedule carries survives the query string", () => {
    const p = readPreArrivalPrefill(new URLSearchParams(buildPreArrivalQuery(SCHEDULE)));
    expect(p).toEqual({
      vessel: "MV PACIFIC CREST",
      voyageRef: "V26-041",
      port: "Santos",
      cargo: "Soybeans",
      etaISO: "2026-08-14T06:00:00.000Z",
      operation: "loading",
      cargoQuantityMt: 62_000,
      scheduleRef: "SCH-0001",
    });
  });

  test("absent fields stay absent rather than becoming empty strings", () => {
    const p = readPreArrivalPrefill(
      new URLSearchParams(
        buildPreArrivalQuery({ vessel: "MV LONE", port: "Rotterdam", cargo: null, eta: null })
      )
    );
    expect(p.cargo).toBeNull();
    expect(p.etaISO).toBeNull();
    expect(p.operation).toBeNull();
    expect(p.cargoQuantityMt).toBeNull();
    expect(p.vessel).toBe("MV LONE");
  });

  test("ports and vessels with spaces and punctuation survive encoding", () => {
    const tricky = { vessel: "MV CAPE MERIDIAN #2", port: "Rio de Janeiro, BR", cargo: "Iron ore fines" };
    const p = readPreArrivalPrefill(new URLSearchParams(buildPreArrivalQuery(tricky)));
    expect(p.vessel).toBe("MV CAPE MERIDIAN #2");
    expect(p.port).toBe("Rio de Janeiro, BR");
    expect(p.cargo).toBe("Iron ore fines");
  });
});

describe("port function mapping", () => {
  test("maps the two cargo operations", () => {
    expect(operationFromPortFunction("load")).toBe("loading");
    expect(operationFromPortFunction("discharge")).toBe("discharge");
  });

  test("refuses to guess for anything else", () => {
    // A bunker call is not a cargo operation. Defaulting it to "loading" would
    // silently model the wrong thing and produce an exposure figure for an
    // operation that is not happening.
    for (const f of ["bunker", "transit", "unknown", "", null, undefined, "LOAD"]) {
      expect(operationFromPortFunction(f)).toBeNull();
    }
  });
});

describe("robustness", () => {
  test("a malformed ETA does not discard the rest", () => {
    const p = readPreArrivalPrefill(new URLSearchParams("vessel=MV+X&port=Santos&eta=not-a-date"));
    expect(p.etaISO).toBeNull();
    expect(p.vessel).toBe("MV X");
    expect(p.port).toBe("Santos");
  });

  test("an unrecognised operation is dropped, not coerced", () => {
    expect(readPreArrivalPrefill(new URLSearchParams("operation=lightering")).operation).toBeNull();
  });

  test("a nonsense quantity is dropped", () => {
    for (const q of ["abc", "-5", "0", ""]) {
      expect(readPreArrivalPrefill(new URLSearchParams(`qtyMt=${q}`)).cargoQuantityMt).toBeNull();
    }
  });

  test("an empty query yields a prefill that reports itself empty", () => {
    const p = readPreArrivalPrefill(new URLSearchParams(""));
    expect(hasPrefill(p)).toBe(false);
  });

  test("any one field is enough to count as a prefill", () => {
    expect(hasPrefill(readPreArrivalPrefill(new URLSearchParams("port=Santos")))).toBe(true);
  });
});

describe("datetime-local conversion", () => {
  test("renders in the viewer's timezone, matching how the input is read back", () => {
    // The page parses the input with `new Date(value)`, which treats a bare
    // datetime-local string as LOCAL time. Formatting the instant as UTC here
    // would shift every prefilled ETA by the viewer's offset.
    const iso = "2026-08-14T06:00:00.000Z";
    const local = isoToDatetimeLocal(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(local).toISOString()).toBe(iso);
  });

  test("a bad instant renders empty rather than Invalid Date", () => {
    expect(isoToDatetimeLocal("nope")).toBe("");
  });
});
