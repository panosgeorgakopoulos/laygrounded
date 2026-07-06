// Seed data — 3 synthetic SoF scenarios for demo.
// 1. Clean GENCON 94 / SHINC / demurrage scenario.
// 2. SHEX-UU with Sunday operations.
// 3. Weather delay conflict flag.

import { CpTerms, EventTypeEnum } from "@/lib/laytime/types";

export interface SeedEvent {
  occurred_at: string;
  event_type: EventTypeEnum;
  verbatim: string;
  page: number;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  reasoning: string;
}

export interface SeedScenario {
  vessel: string;
  voyageRef: string;
  port: string;
  cargo: string;
  cpTerms: CpTerms;
  events: SeedEvent[];
}

const bbox = (y: number) => ({ x: 0.05, y, width: 0.9, height: 0.04 });

export const seedScenarios: SeedScenario[] = [
  // === 1. Clean GENCON 94 / SHINC / demurrage ===
  {
    vessel: "MV Pacific Trader",
    voyageRef: "VR-2024-0142",
    port: "Port Hedland, AU",
    cargo: "Iron Ore Fines, 165,000 MT",
    cpTerms: {
      laytime_allowed_hours: 72,
      load_rate: 10000,
      discharge_rate: 8000,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHINC",
      demurrage_rate: 28000,
      despatch_rate: 14000,
      currency: "USD",
    },
    events: [
      {
        occurred_at: "2024-03-04T08:00:00Z",
        event_type: "NOR_TENDERED",
        verbatim: "Notice of Readiness tendered at anchorage 04/03/2024 08:00 LT.",
        page: 1,
        bbox: bbox(0.18),
        confidence: 0.95,
        reasoning: "NOR tendered at anchorage before berthing.",
      },
      {
        occurred_at: "2024-03-04T14:00:00Z",
        event_type: "ALL_FAST",
        verbatim: "Vessel arrived at berth, all fast at 14:00 LT.",
        page: 1,
        bbox: bbox(0.28),
        confidence: 0.93,
        reasoning: "Berthing complete.",
      },
      {
        occurred_at: "2024-03-04T15:00:00Z",
        event_type: "HATCH_OPEN",
        verbatim: "Hatch covers opened at 15:00 LT, ready to load.",
        page: 1,
        bbox: bbox(0.36),
        confidence: 0.91,
        reasoning: "Hatch open precedes loading.",
      },
      {
        occurred_at: "2024-03-04T16:00:00Z",
        event_type: "COMMENCED_LOADING",
        verbatim: "Loading commenced at 16:00 LT.",
        page: 1,
        bbox: bbox(0.44),
        confidence: 0.97,
        reasoning: "Loading commenced after hatch open.",
      },
      {
        occurred_at: "2024-03-09T16:00:00Z",
        event_type: "COMPLETED_LOADING",
        verbatim: "Loading completed at 16:00 LT, 5 days after commencement.",
        page: 1,
        bbox: bbox(0.72),
        confidence: 0.96,
        reasoning: "Loading completed; laytime window ends.",
      },
      {
        occurred_at: "2024-03-09T17:00:00Z",
        event_type: "HATCH_CLOSE",
        verbatim: "Hatch covers closed at 17:00 LT.",
        page: 1,
        bbox: bbox(0.80),
        confidence: 0.92,
        reasoning: "Hatch close after loading complete.",
      },
    ],
  },

  // === 2. SHEX-UU with Sunday operations ===
  {
    vessel: "MV Star of Bengal",
    voyageRef: "VR-2024-0218",
    port: "Newcastle, AU",
    cargo: "Thermal Coal, 82,500 MT",
    cpTerms: {
      laytime_allowed_hours: 96,
      load_rate: 6000,
      discharge_rate: 5000,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHEX-UU",
      demurrage_rate: 22000,
      despatch_rate: 11000,
      currency: "USD",
    },
    events: [
      {
        occurred_at: "2024-03-08T08:00:00Z",
        event_type: "NOR_TENDERED",
        verbatim: "NOR tendered Friday 08:00 LT, vessel at anchorage.",
        page: 1,
        bbox: bbox(0.18),
        confidence: 0.94,
        reasoning: "NOR tendered Friday before weekend.",
      },
      {
        occurred_at: "2024-03-08T14:00:00Z",
        event_type: "ALL_FAST",
        verbatim: "All fast Friday 14:00 LT.",
        page: 1,
        bbox: bbox(0.28),
        confidence: 0.92,
        reasoning: "Berthing complete.",
      },
      {
        occurred_at: "2024-03-08T15:00:00Z",
        event_type: "HATCH_OPEN",
        verbatim: "Hatch covers opened Friday 15:00 LT.",
        page: 1,
        bbox: bbox(0.36),
        confidence: 0.90,
        reasoning: "Hatch remains open through Sunday operations.",
      },
      {
        occurred_at: "2024-03-08T16:00:00Z",
        event_type: "COMMENCED_LOADING",
        verbatim: "Loading commenced Friday 16:00 LT.",
        page: 1,
        bbox: bbox(0.44),
        confidence: 0.96,
        reasoning: "Loading continues through Sunday under SHEX-UU.",
      },
      {
        occurred_at: "2024-03-10T14:00:00Z",
        event_type: "COMPLETED_LOADING",
        verbatim: "Loading completed Sunday 14:00 LT.",
        page: 1,
        bbox: bbox(0.72),
        confidence: 0.95,
        reasoning: "Sunday operations counted under SHEX-UU.",
      },
    ],
  },

  // === 3. Weather delay conflict flag ===
  {
    vessel: "MV Arctic Horizon",
    voyageRef: "VR-2024-0336",
    port: "Rotterdam, NL",
    cargo: "Soybeans, 54,000 MT",
    cpTerms: {
      laytime_allowed_hours: 48,
      load_rate: 4000,
      discharge_rate: 3500,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "WWDSHEX-EIU",
      demurrage_rate: 18000,
      despatch_rate: 9000,
      currency: "USD",
    },
    events: [
      {
        occurred_at: "2024-03-04T08:00:00Z",
        event_type: "NOR_TENDERED",
        verbatim: "NOR tendered 04/03/2024 08:00 LT at anchorage.",
        page: 1,
        bbox: bbox(0.18),
        confidence: 0.94,
        reasoning: "NOR at anchorage, WIBON applies.",
      },
      {
        occurred_at: "2024-03-04T14:00:00Z",
        event_type: "ALL_FAST",
        verbatim: "All fast at berth 14:00 LT.",
        page: 1,
        bbox: bbox(0.28),
        confidence: 0.92,
        reasoning: "Berthing complete.",
      },
      {
        occurred_at: "2024-03-04T15:00:00Z",
        event_type: "HATCH_OPEN",
        verbatim: "Hatch covers opened 15:00 LT.",
        page: 1,
        bbox: bbox(0.36),
        confidence: 0.91,
        reasoning: "Hatch open.",
      },
      {
        occurred_at: "2024-03-04T16:00:00Z",
        event_type: "COMMENCED_LOADING",
        verbatim: "Loading commenced 16:00 LT.",
        page: 1,
        bbox: bbox(0.44),
        confidence: 0.97,
        reasoning: "Loading commenced.",
      },
      {
        occurred_at: "2024-03-05T12:00:00Z",
        event_type: "WEATHER_DELAY",
        verbatim: "Loading suspended 12:00-14:00 due to heavy rain (hatch still open per stevedore log).",
        page: 1,
        bbox: bbox(0.54),
        confidence: 0.78,
        reasoning: "Weather delay reported — but hatch open + loading noted as ongoing simultaneously; conflicting.",
      },
      {
        occurred_at: "2024-03-05T14:00:00Z",
        event_type: "COMMENCED_LOADING",
        verbatim: "Loading resumed 14:00 LT after rain.",
        page: 1,
        bbox: bbox(0.62),
        confidence: 0.89,
        reasoning: "Loading resumed.",
      },
      {
        occurred_at: "2024-03-06T22:00:00Z",
        event_type: "COMPLETED_LOADING",
        verbatim: "Loading completed 06/03 22:00 LT.",
        page: 1,
        bbox: bbox(0.72),
        confidence: 0.94,
        reasoning: "Loading completed.",
      },
      {
        occurred_at: "2024-03-06T23:00:00Z",
        event_type: "HATCH_CLOSE",
        verbatim: "Hatch covers closed 23:00 LT.",
        page: 1,
        bbox: bbox(0.80),
        confidence: 0.91,
        reasoning: "Hatch close after loading.",
      },
    ],
  },
];
