// A deterministic stand-in for the live AIS feed.
//
// This exists so the ECDF sampling path can be exercised end to end without a
// paid key. It generates a plausible queue: right-skewed waiting times whose
// scale depends on the port, stable within a day and drifting across days.
//
// IT IS SYNTHETIC, AND THAT FACT IS NOT COSMETIC. Everything it returns is
// stamped `source: "mock"`, which `isDecisionGrade` refuses, which strips the
// whole report of decision-grade status and forces a caveat naming this module.
// A realistic-looking invented queue is the single most dangerous artefact in
// this feature — it is indistinguishable from measurement by eye — so the
// guard is structural rather than a convention to remember.
//
// Selection is env-gated in `resolve-congestion.ts`; this module cannot install
// itself.

import { makeRng } from "@/lib/risk/prng";
import { sampleLognormal } from "@/lib/risk/distributions";
import {
  normalizePortKey,
  type AisCongestionAdapter,
  type PortCongestionSnapshot,
} from "@/lib/risk/sources/ais-congestion";

/**
 * Ports with a public reputation for queueing, so the mock is not uniformly
 * bland. Invented magnitudes for a plausible demo — NOT measurements, and not
 * to be mistaken for a congestion ranking.
 */
const PORT_BUSYNESS: Record<string, number> = {
  "port hedland": 1.6,
  newcastle: 1.8,
  "santos": 2.2,
  "paranagua": 2.4,
  "rotterdam": 0.8,
  "new orleans": 1.4,
  "qingdao": 1.7,
  "richards bay": 1.9,
};

function busynessFor(portKey: string): number {
  const head = portKey.split(",")[0].trim();
  for (const [name, factor] of Object.entries(PORT_BUSYNESS)) {
    if (head.includes(name)) return factor;
  }
  return 1.0;
}

/**
 * Seeded by port and UTC date, so a snapshot is stable within a day and moves
 * between days — the temporal behaviour a live feed would have, without the
 * irreproducibility that would make a stored report unauditable.
 */
export function mockSnapshot(port: string, nowISO: string): PortCongestionSnapshot {
  const portKey = normalizePortKey(port);
  const day = nowISO.slice(0, 10);
  const rng = makeRng(`ais-mock:${portKey}:${day}`);
  const busyness = busynessFor(portKey);

  const vesselsAtAnchorage = Math.max(0, Math.round(sampleLognormal(4 * busyness, 0.6, rng.next())));
  // Always enough samples for a usable ECDF, even at a quiet port.
  const sampleCount = Math.max(6, vesselsAtAnchorage);

  const waitingHours = Array.from({ length: sampleCount }, () =>
    Math.round(sampleLognormal(14 * busyness, 0.9, rng.next()) * 10) / 10
  ).sort((a, b) => a - b);

  return {
    portKey,
    portLabel: port,
    observedAt: `${day}T00:00:00.000Z`,
    vesselsAtAnchorage,
    vesselsInPort: Math.max(0, Math.round(sampleLognormal(6 * busyness, 0.5, rng.next()))),
    waitingHoursSorted: waitingHours,
    provenance: {
      source: "mock",
      provider: "laygrounded-mock-ais",
      observedAt: `${day}T00:00:00.000Z`,
      label:
        "SYNTHETIC congestion from the built-in mock AIS provider. Not a measurement of " +
        "any real port.",
    },
  };
}

export function createMockAdapter(nowISO: () => string = () => new Date().toISOString()):
  AisCongestionAdapter {
  return {
    id: "mock",
    async fetchSnapshot(port: string) {
      return mockSnapshot(port, nowISO());
    },
  };
}
