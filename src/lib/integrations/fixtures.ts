// Deterministic ERP fixtures — the mock corpus behind `config.mode = "mock"`.
//
// Pure. No clock, no network, no randomness beyond the seeded PRNG the risk
// engine already uses (`Math.random` is banned in this codebase for exactly the
// reason it matters here).
//
// DETERMINISM IS A CORRECTNESS REQUIREMENT, NOT A CONVENIENCE. Inbound voyages
// upsert on `(company_id, external_source, external_ref)`. If a mock pull
// invented a fresh `externalRef` each sweep, every cron tick would fork a new
// claim and the demo tenant would fill with duplicates. Same seed ⇒ same refs ⇒
// the second pull is a no-op, which is precisely how the live path behaves.
//
// Times are derived from an explicit `anchor` rather than read from the clock,
// so a fixture is reproducible: (seed, anchor) fully determines the output. The
// caller passes `new Date()` in normal use and a fixed instant in tests.

import { makeRng } from "@/lib/risk/prng";
import type { NormalizedSchedule, NormalizedVoyage } from "./types";

const HOUR_MS = 3_600_000;

/** Dry bulk trades a Greek-owned fleet actually runs. */
const LANES: Array<{
  loadPort: string;
  dischargePort: string;
  cargo: string;
  quantityMt: number;
}> = [
  { loadPort: "Tubarao", dischargePort: "Qingdao", cargo: "Iron ore fines", quantityMt: 170_000 },
  { loadPort: "Port Hedland", dischargePort: "Rizhao", cargo: "Iron ore fines", quantityMt: 160_000 },
  { loadPort: "Richards Bay", dischargePort: "Rotterdam", cargo: "Steam coal", quantityMt: 75_000 },
  { loadPort: "Newcastle NSW", dischargePort: "Kaohsiung", cargo: "Thermal coal", quantityMt: 72_000 },
  { loadPort: "Santos", dischargePort: "Qingdao", cargo: "Soybeans", quantityMt: 66_000 },
  { loadPort: "New Orleans", dischargePort: "Damietta", cargo: "Wheat (HRW)", quantityMt: 55_000 },
  { loadPort: "Kamsar", dischargePort: "Yantai", cargo: "Bauxite", quantityMt: 88_000 },
  { loadPort: "Ras Al Khair", dischargePort: "Paradip", cargo: "Urea (bulk)", quantityMt: 42_000 },
];

const VESSEL_STEMS = [
  "AEGEAN",
  "IONIAN",
  "KYTHNOS",
  "MELTEMI",
  "OLYMPIA",
  "PATMOS",
  "SIFNOS",
  "THALASSA",
];

const VESSEL_SUFFIXES = ["TRADER", "PIONEER", "HORIZON", "VOYAGER", "SPIRIT", "GLORY"];

const COUNTERPARTIES = [
  "Hellenic Bulk Chartering S.A.",
  "Piraeus Ocean Trading Ltd",
  "Adriatic Commodities BV",
  "Levant Dry Cargo DMCC",
  "Northwind Shipping GmbH",
];

/**
 * A syntactically valid IMO number for a seeded index.
 *
 * The check digit is computed properly (digits 1–6 weighted 7…2, the last digit
 * of the sum is digit 7) so a fixture survives any downstream IMO validation
 * rather than failing it in a way that looks like a real data-quality bug.
 * The 98xxxxx range is used because no vessel currently carries it.
 */
export function mockImo(index: number): string {
  const base = 9_800_000 + (index % 90_000);
  const digits = String(base).slice(0, 6).split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (7 - i), 0);
  return `${String(base).slice(0, 6)}${sum % 10}`;
}

function pick<T>(rng: { next(): number }, arr: readonly T[]): T {
  return arr[Math.floor(rng.next() * arr.length) % arr.length];
}

/**
 * A short, stable discriminator derived from the seed.
 *
 * This is load-bearing, not decoration. External refs are the upsert key
 * `(company_id, external_source, external_ref)`, and `external_source` is the
 * PROVIDER — so two mock DANAOS integrations in one company would otherwise
 * emit identical refs and fight over the same claims, each sweep overwriting
 * the other's vessel. Mixing the seed into the ref keeps their fleets disjoint.
 */
function seedTag(seed: string): string {
  const rng = makeRng(`tag:${seed}`);
  return Math.floor(rng.next() * 36 ** 4)
    .toString(36)
    .toUpperCase()
    .padStart(4, "0");
}

function vesselName(rng: { next(): number }): string {
  return `${pick(rng, VESSEL_STEMS)} ${pick(rng, VESSEL_SUFFIXES)}`;
}

/**
 * Deterministic voyages for a mock pull.
 *
 * `seed` should be the integration id: two mock integrations in the same
 * company then produce different fleets rather than colliding on the same
 * `external_ref`s and fighting over one set of claims.
 */
export function mockVoyages(
  seed: string,
  opts: { count?: number; anchor?: Date; prefix?: string } = {}
): NormalizedVoyage[] {
  const count = Math.max(1, Math.min(opts.count ?? 4, 50));
  const anchor = opts.anchor ?? new Date();
  const prefix = opts.prefix ?? "MOCK";
  const rng = makeRng(`voyages:${seed}`);
  const tag = seedTag(seed);
  const out: NormalizedVoyage[] = [];

  for (let i = 0; i < count; i++) {
    const lane = pick(rng, LANES);
    const vessel = vesselName(rng);
    // A stable sequence number, NOT a timestamp: the ref must be identical on
    // the next pull for the upsert to dedupe.
    const seq = 4200 + i;
    out.push({
      externalRef: `${prefix}-VOY-${tag}-${seq}`,
      vessel,
      vesselImo: mockImo(i + Math.floor(rng.next() * 1000)),
      voyageRef: `${seq}/${anchor.getUTCFullYear()}`,
      // The discharge port is the one that generates the demurrage claim more
      // often, so it is the port carried on the imported claim.
      port: lane.dischargePort,
      cargo: lane.cargo,
      counterpartyName: pick(rng, COUNTERPARTIES),
      updatedAt: new Date(anchor.getTime() - i * 6 * HOUR_MS).toISOString(),
    });
  }
  return out;
}

/**
 * Deterministic forward schedules for a mock pull.
 *
 * Spread across the next ~14 days from the anchor, because the consumer of a
 * schedule is the pre-arrival risk engine and a schedule in the past is not a
 * schedule. ETB is deliberately absent on roughly a third of the rows: real
 * ERPs frequently have an ETA with no berth assigned yet, and code that assumes
 * ETB is always present would pass its tests here and fail on first contact.
 */
export function mockSchedules(
  seed: string,
  opts: { count?: number; anchor?: Date; prefix?: string } = {}
): NormalizedSchedule[] {
  const count = Math.max(1, Math.min(opts.count ?? 5, 50));
  const anchor = opts.anchor ?? new Date();
  const prefix = opts.prefix ?? "MOCK";
  const rng = makeRng(`schedules:${seed}`);
  const tag = seedTag(seed);
  const out: NormalizedSchedule[] = [];

  for (let i = 0; i < count; i++) {
    const lane = pick(rng, LANES);
    const loading = rng.next() < 0.5;
    const etaOffsetH = 18 + Math.floor(rng.next() * 300);
    const eta = new Date(anchor.getTime() + etaOffsetH * HOUR_MS);
    const hasBerth = rng.next() > 0.34;
    const etb = hasBerth ? new Date(eta.getTime() + (6 + rng.next() * 40) * HOUR_MS) : null;
    const etd = etb ? new Date(etb.getTime() + (36 + rng.next() * 72) * HOUR_MS) : null;
    // Laycan brackets the ETA, which is what makes a laycan-miss meaningful.
    const laycanFrom = new Date(eta.getTime() - (24 + rng.next() * 72) * HOUR_MS);
    const laycanTo = new Date(laycanFrom.getTime() + (5 + rng.next() * 6) * 24 * HOUR_MS);
    const seq = 7100 + i;

    out.push({
      externalRef: `${prefix}-SCH-${tag}-${seq}`,
      vessel: vesselName(rng),
      vesselImo: mockImo(i * 7 + 13),
      voyageRef: `${seq}/${anchor.getUTCFullYear()}`,
      port: loading ? lane.loadPort : lane.dischargePort,
      portFunction: loading ? "load" : "discharge",
      etaISO: eta.toISOString(),
      etbISO: etb ? etb.toISOString() : null,
      etdISO: etd ? etd.toISOString() : null,
      laycanFromISO: laycanFrom.toISOString(),
      laycanToISO: laycanTo.toISOString(),
      cargo: lane.cargo,
      cargoQuantityMt: lane.quantityMt,
      updatedAt: new Date(anchor.getTime() - i * 3 * HOUR_MS).toISOString(),
    });
  }
  return out;
}

/**
 * Filters a fixture set by the caller's `since` cursor.
 *
 * Mirrors what a live ERP does with `lastUpdatedAfter`, so the sync engine's
 * incremental behaviour is exercised by the mock rather than only in production.
 */
export function filterSince<T extends { updatedAt?: string }>(
  rows: T[],
  sinceISO: string | null
): T[] {
  if (!sinceISO) return rows;
  const since = new Date(sinceISO).getTime();
  if (Number.isNaN(since)) return rows;
  return rows.filter((r) => {
    if (!r.updatedAt) return true;
    const t = new Date(r.updatedAt).getTime();
    return Number.isNaN(t) ? true : t > since;
  });
}
