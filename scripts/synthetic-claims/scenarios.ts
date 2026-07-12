// Scenario archetypes for the synthetic claim generator.
//
// Each archetype builds a randomized-but-valid voyage exercising ONE edge case
// of the laytime engine, plus a `feature` predicate that proves (against the
// computed result) that the edge case actually manifested — a weather case
// whose weather never got excluded is rejected and regenerated, never emitted.
//
// All wall-clock times are constructed in the port's IANA timezone via
// date-fns-tz and stored as UTC ISO — exactly what the engine consumes.

import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { CpTerms, EventTypeEnum, LaytimeResult } from "../../src/lib/laytime/types";
import { Rng } from "./rng";

export interface SyntheticEvent {
  id: string;
  occurred_at: string;
  event_type: EventTypeEnum;
  verbatim: string;
}

export interface Scenario {
  archetype: string;
  description: string;
  claim: {
    vessel: string;
    voyageRef: string;
    port: string;
    cargo: string;
    portTimezone: string;
  };
  cpTerms: CpTerms;
  events: SyntheticEvent[];
  // For error archetypes: regex source the engine's thrown message must match.
  expectError?: string;
  // For time-bar archetypes: frozen "now" and the band the case must land in.
  timeBar?: {
    asOf: string;
    timeBarDays: number;
    intendedState: "ok" | "warning" | "critical" | "expired";
  };
  feature?: (result: LaytimeResult) => boolean;
}

export interface Archetype {
  name: string;
  weight: number;
  build: (rng: Rng) => Scenario;
}

// === Fixture pools ===

const PORTS = [
  { name: "Santos", tz: "America/Sao_Paulo" },
  { name: "Singapore", tz: "Asia/Singapore" },
  { name: "Rotterdam", tz: "Europe/Amsterdam" },
  { name: "Houston", tz: "America/Chicago" },
  { name: "Qingdao", tz: "Asia/Shanghai" },
  { name: "Richards Bay", tz: "Africa/Johannesburg" },
  { name: "Newcastle", tz: "Australia/Sydney" },
  { name: "Gibraltar", tz: "Europe/Gibraltar" },
] as const;

const VESSELS = [
  "OCEAN HARMONY", "IRON DUKE", "PACIFIC CREST", "BALTIC TRADER", "CAPE MERIDIAN",
  "GOLDEN WAVE", "SILVER GULL", "ATLANTIC SPIRIT", "EASTERN STAR", "NORTHERN LIGHT",
  "CORAL EMPRESS", "AMBER DAWN", "BLUE HORIZON", "STELLAR PIONEER", "GRAND VOYAGER",
  "CRIMSON TIDE", "EMERALD SEAS", "MISTRAL WIND", "POLARIS QUEEN", "SOUTHERN CROSS",
] as const;

const DRY_CARGOES = ["Soybeans", "Iron ore fines", "Steam coal", "Wheat in bulk", "Bauxite", "Urea prills", "Corn in bulk"] as const;
const WET_CARGOES = ["Crude oil", "Fuel oil 380cst", "Gasoil", "Naphtha"] as const;

const PHRASES: Record<string, readonly string[]> = {
  NOR_TENDERED: [
    "Notice of Readiness tendered",
    "NOR tendered by Master",
    "NOR tendered and accepted by agents",
  ],
  ALL_FAST: ["Vessel all fast alongside berth", "All fast", "Vessel all fast, gangway secured"],
  BERTHED: ["Vessel berthed", "First line ashore, vessel berthed"],
  HATCH_OPEN: ["Hatches opened", "All hatches open, ready for cargo"],
  HATCH_CLOSE: ["Hatches closed"],
  COMMENCED_LOADING: ["Commenced loading", "Loading commenced all hatches"],
  COMPLETED_LOADING: ["Completed loading", "Loading completed, cargo documents on board"],
  COMMENCED_DISCHARGE: ["Commenced discharge", "Discharge commenced"],
  COMPLETED_DISCHARGE: ["Completed discharge", "Discharge completed, holds swept clean"],
  WEATHER_DELAY: [
    "Rain — all work stopped",
    "Heavy swell, cargo operations suspended",
    "High winds, cranes secured — work stopped",
  ],
  WEATHER_DELAY_END: ["Weather improved — work resumed", "Weather moderated, operations resumed"],
  SHIFTING: ["Commenced shifting from anchorage to berth", "Vessel shifting to working berth"],
  SHIFTING_END: ["Completed shifting", "Shifting completed, vessel in position"],
  STRIKE_START: [
    "Stevedores' strike commenced — all work stopped",
    "Port workers industrial action — operations suspended",
  ],
  STRIKE_END: ["Strike ended — work resumed", "Industrial action lifted, operations resumed"],
  BUNKER_START: [
    "Cargo operations suspended — vessel bunkering, insufficient bunkers on board",
    "Ops suspended for emergency bunkering alongside",
  ],
  BUNKER_END: ["Bunkering completed — cargo operations resumed"],
};

// === Time helpers ===

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localToUtc(tz: string, y: number, m1: number, d: number, h: number, min = 0): Date {
  return fromZonedTime(`${y}-${pad2(m1)}-${pad2(d)}T${pad2(h)}:${pad2(min)}:00`, tz);
}

function addH(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * HOUR_MS);
}

interface CalendarDay {
  y: number;
  m1: number;
  d: number;
}

// Random calendar day in 2023-01-01 .. 2026-04-30 (UTC calendar; used as a
// local calendar date, which is always valid).
function randomDay(rng: Rng): CalendarDay {
  const t = Date.UTC(2023, 0, 1) + rng.int(0, 1215) * DAY_MS;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m1: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// First day on/after a random day whose LOCAL day-of-week in tz matches.
function randomDayWithLocalDow(rng: Rng, tz: string, dow: number): CalendarDay {
  let day = randomDay(rng);
  for (let i = 0; i < 7; i++) {
    const noon = localToUtc(tz, day.y, day.m1, day.d, 12);
    if (toZonedTime(noon, tz).getDay() === dow) return day;
    const next = toZonedTime(new Date(noon.getTime() + DAY_MS), tz);
    day = { y: next.getFullYear(), m1: next.getMonth() + 1, d: next.getDate() };
  }
  return day;
}

class Timeline {
  events: SyntheticEvent[] = [];
  private n = 0;

  add(rng: Rng, at: Date, type: EventTypeEnum, phraseKey: string = type): Date {
    this.events.push({
      id: `e${++this.n}`,
      occurred_at: at.toISOString(),
      event_type: type,
      verbatim: rng.pick(PHRASES[phraseKey] ?? [phraseKey]),
    });
    return at;
  }
}

// === Shared scaffolding ===

function claimHeader(rng: Rng, port: (typeof PORTS)[number], wet = false) {
  return {
    vessel: rng.pick(VESSELS),
    voyageRef: `V${rng.int(23, 26)}-${pad2(rng.int(1, 99))}${rng.int(0, 9)}`,
    port: port.name,
    cargo: wet ? rng.pick(WET_CARGOES) : rng.pick(DRY_CARGOES),
    portTimezone: port.tz,
  };
}

function baseCp(rng: Rng, tz: string, over: Partial<CpTerms>): CpTerms {
  const demurrage = rng.int(36, 90) * 500; // 18,000 .. 45,000 per day
  return {
    laytime_allowed_hours: 72,
    load_rate: rng.int(4, 12) * 1000,
    discharge_rate: rng.int(3, 10) * 1000,
    turn_time_hours: rng.pick([0, 6, 6, 12]),
    nor_variant: "WIBON",
    days_basis: "SHINC",
    demurrage_rate: demurrage,
    despatch_rate: demurrage / 2,
    currency: rng.chance(0.85) ? "USD" : "EUR",
    port_timezone: tz,
    ...over,
  };
}

type OpKind = "LOADING" | "DISCHARGE";

function opEvents(kind: OpKind): { start: EventTypeEnum; end: EventTypeEnum } {
  return kind === "LOADING"
    ? { start: "COMMENCED_LOADING", end: "COMPLETED_LOADING" }
    : { start: "COMMENCED_DISCHARGE", end: "COMPLETED_DISCHARGE" };
}

// Standard dry-cargo opening: NOR → all fast → (hatch open) → ops commence.
// Returns the ops-start instant so callers append interruptions + completion.
function dryOpening(
  rng: Rng,
  tl: Timeline,
  nor: Date,
  op: { start: EventTypeEnum; end: EventTypeEnum },
  withHatch: boolean
): Date {
  const fast = tl.add(rng, addH(nor, rng.int(2, 6)), "ALL_FAST");
  if (withHatch) tl.add(rng, addH(fast, 1), "HATCH_OPEN");
  return tl.add(rng, addH(fast, rng.int(1, 3)), op.start);
}

// === Archetypes ===

function cleanShinc(rng: Rng, wantDemurrage: boolean): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const nor = tl.add(
    rng,
    localToUtc(port.tz, day.y, day.m1, day.d, rng.pick([6, 8, 9, 10]), rng.chance(0.3) ? 30 : 0),
    "NOR_TENDERED"
  );
  const opsStart = dryOpening(rng, tl, nor, op, rng.chance(0.5));
  const window = rng.int(36, 120);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    laytime_allowed_hours: wantDemurrage
      ? rng.int(8, Math.max(9, Math.floor(window * 0.6)))
      : window + rng.int(12, 72),
  });

  return {
    archetype: wantDemurrage ? "clean-shinc-demurrage" : "clean-shinc-despatch",
    description: wantDemurrage
      ? "Clean SHINC voyage overrunning its allowance — straight demurrage."
      : "Clean SHINC voyage completing early — despatch payable.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      wantDemurrage ? r.totals.demurrage_amount > 0 : r.totals.despatch_amount > 0,
  };
}

function weatherWwd(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  // Anchor Monday: keeps Sundays out of short windows so the excluded rows
  // are unambiguously weather, not day-of-week exceptions.
  const day = randomDayWithLocalDow(rng, port.tz, 1);
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);

  const window = rng.int(48, 100);
  let cursor = rng.int(3, 10);
  const intervals = rng.int(1, 3);
  for (let i = 0; i < intervals && cursor + 6 < window - 4; i++) {
    const len = rng.int(2, 6);
    tl.add(rng, addH(opsStart, cursor), "WEATHER_DELAY");
    tl.add(rng, addH(opsStart, cursor + len), "WEATHER_DELAY_END");
    cursor += len + rng.int(4, 12);
  }
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: "WWDSHEX-EIU",
    laytime_allowed_hours: window + rng.int(-10, 30), // exclusions decide the outcome
  });

  return {
    archetype: "weather-wwd-excluded",
    description: "WWDSHEX-EIU: logged weather interruptions excluded from laytime.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      r.breakdown.some((row) => row.status === "weather_delay" && !row.counts),
  };
}

function weatherOnDemurrage(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 1);
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);

  const allowed = rng.int(6, 14);
  // Weather begins safely after the allowance is exhausted.
  const weatherAt = allowed + rng.int(6, 16);
  const weatherLen = rng.int(3, 8);
  tl.add(rng, addH(opsStart, weatherAt), "WEATHER_DELAY");
  tl.add(rng, addH(opsStart, weatherAt + weatherLen), "WEATHER_DELAY_END");
  tl.add(rng, addH(opsStart, weatherAt + weatherLen + rng.int(4, 20)), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: "SHINC",
    laytime_allowed_hours: allowed,
    // Keep turn time ≤ 6h so commencement never trails ops start far enough
    // for the weather window to slip back inside the allowance.
    turn_time_hours: rng.pick([0, 6]),
  });

  return {
    archetype: "weather-on-demurrage-counts",
    description:
      "GENCON 94 Cl.8: once on demurrage, weather does not interrupt — the weather window bills at the full rate.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      r.totals.demurrage_amount > 0 &&
      r.breakdown.every((row) => row.status !== "weather_delay"),
  };
}

function openEndedWeather(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 1);
  const op = opEvents("DISCHARGE");
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);

  const weatherAt = rng.int(4, 12);
  tl.add(rng, addH(opsStart, weatherAt), "WEATHER_DELAY");
  // No WEATHER_DELAY_END — the delay must conservatively run to completion.
  const completion = tl.add(rng, addH(opsStart, weatherAt + rng.int(10, 40)), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: "WWDSHEX-EIU",
    laytime_allowed_hours: weatherAt + rng.int(20, 60),
  });

  return {
    archetype: "weather-open-interval",
    description:
      "Weather delay with no logged end: excluded all the way to completion, never cut short by unrelated events.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => {
      const last = r.breakdown[r.breakdown.length - 1];
      return (
        !!last &&
        last.status === "weather_delay" &&
        !last.counts &&
        last.end_time === completion.toISOString()
      );
    },
  };
}

function shexSundayExcluded(rng: Rng, basis: "SHEX" | "SSHEX"): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 5); // Friday
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);
  const window = rng.int(70, 110); // safely straddles the weekend
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: basis,
    turn_time_hours: 6,
    laytime_allowed_hours: window + rng.int(0, 40), // exceptions arrive pre-exhaustion
  });

  return {
    archetype: basis === "SSHEX" ? "sshex-weekend-excluded" : "shex-sunday-excluded",
    description:
      basis === "SSHEX"
        ? "SSHEX: Saturdays and Sundays excluded while the allowance still runs."
        : "SHEX: Sunday excluded while the allowance still runs.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => r.breakdown.some((row) => row.status === "excepted" && !row.counts),
  };
}

function shexUuSundayWorked(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 5); // Friday
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  // Hatch open and never closed + continuous ops → Sunday "unless used" counts.
  const opsStart = dryOpening(rng, tl, nor, op, true);
  const window = rng.int(70, 110);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: rng.chance(0.5) ? "SHEX-UU" : "SSHEX-UU",
    turn_time_hours: 6,
    laytime_allowed_hours: window + rng.int(0, 40),
  });

  return {
    archetype: "shex-uu-worked-counts",
    description:
      "SHEX-UU with hatches open and cargo working through the weekend: excepted hours count (Cl.7(d)).",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => r.breakdown.some((row) => row.status === "excepted" && row.counts),
  };
}

function shexCommencementPushed(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 6); // Saturday
  const op = opEvents("LOADING");
  const tl = new Timeline();
  // NOR late Saturday + 6h turn time lands the nominal commencement inside
  // Sunday — the engine must defer it off the excepted day.
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, rng.pick([19, 20, 21])), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);
  const window = rng.int(30, 60);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: "SHEX",
    turn_time_hours: 6,
    laytime_allowed_hours: rng.int(24, 60),
  });
  const nominalCommencement = addH(nor, 6).toISOString();

  return {
    archetype: "shex-commencement-deferred",
    description:
      "NOR late Saturday under SHEX: nominal commencement falls on Sunday and must be deferred off the excepted day.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      r.breakdown.length > 0 && r.breakdown[0].start_time > nominalCommencement,
  };
}

function shifting(rng: Rng, counts: boolean): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 1); // Monday — no Sunday masking
  const kind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(kind);
  const tl = new Timeline();
  const turn = 6;
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  // Shifting spans the commencement instant so the interval lands in-window.
  const shiftStart = addH(nor, turn);
  const shiftLen = rng.int(2, 5);
  tl.add(rng, shiftStart, "SHIFTING");
  tl.add(rng, addH(shiftStart, shiftLen), "SHIFTING_END");
  const fast = tl.add(rng, addH(shiftStart, shiftLen), "ALL_FAST");
  const opsStart = tl.add(rng, addH(fast, rng.int(1, 3)), op.start);
  const window = rng.int(24, 80);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    nor_variant: counts ? "WIBON" : rng.pick(["WIPON", "WICCON", "WIFPON"]),
    turn_time_hours: turn,
    laytime_allowed_hours: rng.int(16, Math.max(17, window)),
  });

  return {
    archetype: counts ? "wibon-shifting-counts" : "non-wibon-shifting-excluded",
    description: counts
      ? "WIBON: shifting from anchorage to berth counts as laytime."
      : "WIPON/WICCON/WIFPON: shifting to berth does not count as laytime.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      r.breakdown.some((row) => row.status === "shifting" && row.counts === counts),
  };
}

function exceptedPeriod(rng: Rng, kind: "strike" | "bunker"): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 1); // Monday: window stays Sunday-free
  const opKind: OpKind = rng.chance(0.5) ? "LOADING" : "DISCHARGE";
  const op = opEvents(opKind);
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const opsStart = dryOpening(rng, tl, nor, op, false);

  const stopAt = rng.int(4, 16);
  const stopLen = rng.int(4, 18);
  tl.add(rng, addH(opsStart, stopAt), "EXCEPTED_PERIOD_START", kind === "strike" ? "STRIKE_START" : "BUNKER_START");
  tl.add(rng, addH(opsStart, stopAt + stopLen), "EXCEPTED_PERIOD_END", kind === "strike" ? "STRIKE_END" : "BUNKER_END");
  const window = stopAt + stopLen + rng.int(10, 50);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    // NOTE: the engine only excludes explicit excepted periods under
    // SHEX-family bases (under SHINC they count, Cl.7(b) branch) — a known
    // behavior these goldens deliberately pin down.
    days_basis: "SHEX",
    laytime_allowed_hours: window + rng.int(0, 30),
  });

  return {
    archetype: kind === "strike" ? "port-strike-excepted" : "bunker-shortage-excepted",
    description:
      kind === "strike"
        ? "Stevedores' strike logged as an excepted period — excluded from laytime under SHEX."
        : "Cargo ops suspended for emergency bunkering — logged excepted period excluded under SHEX.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => r.breakdown.some((row) => row.status === "excepted" && !row.counts),
  };
}

// === ASBATANKVOY (tanker) archetypes ===

function asbaBase(rng: Rng, over: Partial<CpTerms>, port: (typeof PORTS)[number]): CpTerms {
  return baseCp(rng, port.tz, {
    cp_form: "ASBATANKVOY",
    turn_time_hours: 6,
    days_basis: "SHINC",
    ...over,
  });
}

function asbaClean(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const op = opEvents(rng.chance(0.5) ? "LOADING" : "DISCHARGE");
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, rng.pick([4, 8, 14, 22])), "NOR_TENDERED");
  const fast = tl.add(rng, addH(nor, rng.int(7, 14)), "ALL_FAST"); // after turn time
  const opsStart = tl.add(rng, addH(fast, 1), op.start);
  const window = rng.int(20, 60);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = asbaBase(rng, { laytime_allowed_hours: rng.int(12, window + 24) }, port);
  return {
    archetype: "asba-running-hours",
    description: "ASBATANKVOY running hours: Sundays included, laytime runs continuously.",
    claim: claimHeader(rng, port, true),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => r.breakdown.some((row) => row.clause_ref.startsWith("ASBA")),
  };
}

function asbaBerthCutsTurn(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const op = opEvents("LOADING");
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const fast = tl.add(rng, addH(nor, rng.int(1, 5)), "ALL_FAST"); // before 6h turn expiry
  const opsStart = tl.add(rng, addH(fast, 0), op.start);
  const window = rng.int(20, 60);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = asbaBase(rng, { laytime_allowed_hours: rng.int(12, window) }, port);
  const fastIso = fast.toISOString();
  return {
    archetype: "asba-berth-cuts-turn-time",
    description:
      "ASBATANKVOY Cl.6: berthing before the 6-hour turn time expires commences laytime immediately.",
    claim: claimHeader(rng, port, true),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => r.breakdown.length > 0 && r.breakdown[0].start_time === fastIso,
  };
}

function asbaHalfRate(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const op = opEvents(rng.chance(0.5) ? "LOADING" : "DISCHARGE");
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const fast = tl.add(rng, addH(nor, 2), "ALL_FAST");
  const opsStart = tl.add(rng, addH(fast, 0), op.start);

  const allowed = rng.int(8, 16);
  const stormAt = allowed + rng.int(4, 12); // storm strikes while on demurrage
  const stormLen = rng.int(3, 9);
  tl.add(rng, addH(opsStart, stormAt), "WEATHER_DELAY");
  tl.add(rng, addH(opsStart, stormAt + stormLen), "WEATHER_DELAY_END");
  tl.add(rng, addH(opsStart, stormAt + stormLen + rng.int(4, 16)), op.end);

  const cp = asbaBase(rng, { laytime_allowed_hours: allowed }, port);
  return {
    archetype: "asba-half-rate-demurrage",
    description:
      "ASBATANKVOY Cl.8: storm while on demurrage — those hours bill at half the demurrage rate.",
    claim: claimHeader(rng, port, true),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => (r.totals.demurrage_half_rate_hours ?? 0) > 0,
  };
}

function asbaBerthDelay(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const op = opEvents("DISCHARGE");
  const tl = new Timeline();
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  // Delay getting into berth spans the post-turn-time window.
  const shiftStart = addH(nor, 6);
  const shiftLen = rng.int(2, 6);
  tl.add(rng, shiftStart, "SHIFTING");
  tl.add(rng, addH(shiftStart, shiftLen), "SHIFTING_END");
  const fast = tl.add(rng, addH(shiftStart, shiftLen), "ALL_FAST");
  const opsStart = tl.add(rng, addH(fast, 1), op.start);
  const window = rng.int(20, 60);
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = asbaBase(rng, { laytime_allowed_hours: rng.int(16, window + 12) }, port);
  return {
    archetype: "asba-berth-delay-excluded",
    description:
      "ASBATANKVOY Cl.6: delay getting into berth after NOR does not count as used laytime, regardless of NOR variant.",
    claim: claimHeader(rng, port, true),
    cpTerms: cp,
    events: tl.events,
    feature: (r) =>
      r.breakdown.some(
        (row) => row.status === "shifting" && !row.counts && row.clause_ref === "ASBA-II-6"
      ),
  };
}

// === Stress + errors + time bars ===

function multiInterruptionStress(rng: Rng): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDayWithLocalDow(rng, port.tz, 5); // Friday: weekend inside window
  const op = opEvents(rng.chance(0.5) ? "LOADING" : "DISCHARGE");
  const tl = new Timeline();
  const turn = 6;
  const nor = tl.add(rng, localToUtc(port.tz, day.y, day.m1, day.d, 8), "NOR_TENDERED");
  const shiftLen = rng.int(2, 4);
  tl.add(rng, addH(nor, turn), "SHIFTING");
  tl.add(rng, addH(nor, turn + shiftLen), "SHIFTING_END");
  const fast = tl.add(rng, addH(nor, turn + shiftLen), "ALL_FAST");
  tl.add(rng, addH(fast, 1), "HATCH_OPEN");
  const opsStart = tl.add(rng, addH(fast, 2), op.start);

  let cursor = rng.int(4, 10);
  for (let i = 0; i < rng.int(1, 2); i++) {
    const len = rng.int(2, 6);
    tl.add(rng, addH(opsStart, cursor), "WEATHER_DELAY");
    tl.add(rng, addH(opsStart, cursor + len), "WEATHER_DELAY_END");
    cursor += len + rng.int(6, 14);
  }
  if (rng.chance(0.5)) {
    const len = rng.int(3, 8);
    tl.add(rng, addH(opsStart, cursor), "EXCEPTED_PERIOD_START", "STRIKE_START");
    tl.add(rng, addH(opsStart, cursor + len), "EXCEPTED_PERIOD_END", "STRIKE_END");
    cursor += len + rng.int(4, 10);
  }
  const window = Math.max(cursor + 10, rng.int(90, 140));
  tl.add(rng, addH(opsStart, window), op.end);

  const cp = baseCp(rng, port.tz, {
    days_basis: "WWDSHEX-EIU",
    nor_variant: rng.pick(["WIBON", "WIPON"]),
    turn_time_hours: turn,
    laytime_allowed_hours: rng.int(30, 100),
  });

  return {
    archetype: "multi-interruption-stress",
    description:
      "Stress case: shifting + weather + weekend (and sometimes a strike) stacked in one WWDSHEX-EIU voyage.",
    claim: claimHeader(rng, port),
    cpTerms: cp,
    events: tl.events,
    feature: (r) => new Set(r.breakdown.map((row) => row.status)).size >= 3,
  };
}

function errorCase(rng: Rng, kind: "no-nor" | "multiple-nor"): Scenario {
  const port = rng.pick(PORTS);
  const day = randomDay(rng);
  const op = opEvents("LOADING");
  const tl = new Timeline();
  const base = localToUtc(port.tz, day.y, day.m1, day.d, 8);
  if (kind === "multiple-nor") {
    tl.add(rng, base, "NOR_TENDERED");
    tl.add(rng, addH(base, rng.int(2, 12)), "NOR_TENDERED");
  }
  const opsStart = tl.add(rng, addH(base, rng.int(6, 12)), op.start);
  tl.add(rng, addH(opsStart, rng.int(20, 60)), op.end);

  return {
    archetype: kind === "no-nor" ? "error-no-nor" : "error-multiple-nor",
    description:
      kind === "no-nor"
        ? "SoF with no NOR: the engine must refuse with NO_NOR, never guess a commencement."
        : "Two NOR events: the engine must refuse with MULTIPLE_NOR.",
    claim: claimHeader(rng, port),
    cpTerms: baseCp(rng, port.tz, { laytime_allowed_hours: rng.int(24, 72) }),
    events: tl.events,
    expectError: kind === "no-nor" ? "NO_NOR" : "MULTIPLE_NOR",
  };
}

function timeBarCase(
  rng: Rng,
  intended: "ok" | "warning" | "critical" | "expired"
): Scenario {
  const base = cleanShinc(rng, rng.chance(0.5));
  const completion = base.events
    .filter((e) => e.event_type.startsWith("COMPLETED_"))
    .map((e) => new Date(e.occurred_at).getTime())
    .sort((a, b) => a - b)
    .pop()!;
  const timeBarDays = rng.pick([30, 60, 90, 90]);
  const deadline = completion + timeBarDays * DAY_MS;

  // Offset from the deadline chosen to land daysRemaining in the target band
  // (ok > 21, warning 8–21, critical 0–7, expired < 0).
  const daysLeft =
    intended === "expired"
      ? -rng.int(1, 45)
      : intended === "critical"
        ? rng.int(0, 7)
        : intended === "warning"
          ? rng.int(8, 21)
          : rng.int(22, 80);
  // asOf at midday of the target day so floor() lands exactly on daysLeft.
  const asOf = new Date(deadline - daysLeft * DAY_MS - 12 * HOUR_MS);

  return {
    ...base,
    archetype: `timebar-${intended}`,
    description: `Time-bar countdown in the "${intended}" band (${timeBarDays}-day bar). ${base.description}`,
    timeBar: {
      asOf: asOf.toISOString(),
      timeBarDays,
      intendedState: intended,
    },
  };
}

// === Registry ===

export const ARCHETYPES: Archetype[] = [
  { name: "clean-shinc-demurrage", weight: 30, build: (r) => cleanShinc(r, true) },
  { name: "clean-shinc-despatch", weight: 30, build: (r) => cleanShinc(r, false) },
  { name: "weather-wwd-excluded", weight: 45, build: weatherWwd },
  { name: "weather-on-demurrage-counts", weight: 25, build: weatherOnDemurrage },
  { name: "weather-open-interval", weight: 20, build: openEndedWeather },
  { name: "shex-sunday-excluded", weight: 28, build: (r) => shexSundayExcluded(r, "SHEX") },
  { name: "sshex-weekend-excluded", weight: 22, build: (r) => shexSundayExcluded(r, "SSHEX") },
  { name: "shex-uu-worked-counts", weight: 30, build: shexUuSundayWorked },
  { name: "shex-commencement-deferred", weight: 20, build: shexCommencementPushed },
  { name: "wibon-shifting-counts", weight: 25, build: (r) => shifting(r, true) },
  { name: "non-wibon-shifting-excluded", weight: 25, build: (r) => shifting(r, false) },
  { name: "port-strike-excepted", weight: 30, build: (r) => exceptedPeriod(r, "strike") },
  { name: "bunker-shortage-excepted", weight: 25, build: (r) => exceptedPeriod(r, "bunker") },
  { name: "asba-running-hours", weight: 25, build: asbaClean },
  { name: "asba-berth-cuts-turn-time", weight: 20, build: asbaBerthCutsTurn },
  { name: "asba-half-rate-demurrage", weight: 25, build: asbaHalfRate },
  { name: "asba-berth-delay-excluded", weight: 20, build: asbaBerthDelay },
  { name: "multi-interruption-stress", weight: 40, build: multiInterruptionStress },
  { name: "error-no-nor", weight: 8, build: (r) => errorCase(r, "no-nor") },
  { name: "error-multiple-nor", weight: 7, build: (r) => errorCase(r, "multiple-nor") },
  { name: "timebar-expired", weight: 10, build: (r) => timeBarCase(r, "expired") },
  { name: "timebar-critical", weight: 8, build: (r) => timeBarCase(r, "critical") },
  { name: "timebar-warning", weight: 8, build: (r) => timeBarCase(r, "warning") },
  { name: "timebar-ok", weight: 9, build: (r) => timeBarCase(r, "ok") },
];
