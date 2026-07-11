/// <reference types="bun-types" />
// Table-driven unit tests for the GENCON 94 laytime engine.
// Run with: bun test src/lib/laytime/gencon94.test.ts

import { describe, it, expect } from "bun:test";
import { recomputeLaytime } from "./gencon94";
import { CpTerms, LaytimeResult, SofEventInput } from "./types";

interface Fixture {
  name: string;
  description: string;
  events: SofEventInput[];
  cpTerms: CpTerms;
  expected: LaytimeResult;
}

// Helper to construct an ISO timestamp.
function iso(dateStr: string): string {
  return new Date(dateStr).toISOString();
}

// === Fixtures ===
const fixtures: Fixture[] = [
  // 1. Clean WIBON + SHINC, no exceptions
  {
    name: "clean-wibon-shinc-demurrage",
    description:
      "Clean SHINC voyage. NOR tendered, 6h turn time. Window 14:00→next-day 16:00 (26h). Allowed 12h → demurrage starts at 02:00 next day, 14h demurrage.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "ALL_FAST" },
      { id: "3", occurred_at: iso("2024-03-04T15:00:00Z"), event_type: "HATCH_OPEN" },
      { id: "4", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "5", occurred_at: iso("2024-03-05T16:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 12,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHINC",
      demurrage_rate: 25000,
      despatch_rate: 12500,
      currency: "USD",
    },
    expected: {
      // Laytime commences 14:00. Window: 14:00 → next-day 16:00 = 26h.
      // Allowed 12h → 12h laytime (14:00-02:00) + 14h demurrage (02:00-16:00).
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-05T02:00:00Z"),
          duration_hours: 12,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-05T02:00:00Z"),
          end_time: iso("2024-03-05T16:00:00Z"),
          duration_hours: 14,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 12,
        used_hours: 26,
        time_on_demurrage_hours: 14,
        time_saved_hours: 0,
        demurrage_amount: 14583.33,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 2. SHEX-UU with Sunday operations (hatch open) — counts
  {
    name: "shex-uu-sunday-operations-count",
    description:
      "SHEX-UU: Sunday operations with hatch open → Sunday counts. Allowed 12h, demurrage begins Sat 02:00 (38h before Sunday).",
    events: [
      // NOR Friday 08:00; turn 6h → commence Friday 14:00.
      { id: "1", occurred_at: iso("2024-03-08T08:00:00Z"), event_type: "NOR_TENDERED" }, // Friday
      { id: "2", occurred_at: iso("2024-03-08T14:00:00Z"), event_type: "ALL_FAST" },
      { id: "3", occurred_at: iso("2024-03-08T15:00:00Z"), event_type: "HATCH_OPEN" },
      // Commence loading Friday 16:00; complete Sunday 16:00.
      { id: "4", occurred_at: iso("2024-03-08T16:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "5", occurred_at: iso("2024-03-10T16:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 12,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHEX-UU",
      demurrage_rate: 25000,
      despatch_rate: 12500,
      currency: "USD",
    },
    expected: {
      // Laytime commences Fri 14:00. Allowed 12h → demurrage begins at Sat 02:00.
      // Once on demurrage, Sunday does not interrupt.
      // Fri 14:00 → Sat 02:00: 12h laytime (used 12)
      // Sat 02:00 → Sun 16:00: 38h demurrage (used 50)
      breakdown: [
        {
          start_time: iso("2024-03-08T14:00:00Z"),
          end_time: iso("2024-03-09T02:00:00Z"),
          duration_hours: 12,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-09T02:00:00Z"),
          end_time: iso("2024-03-10T16:00:00Z"),
          duration_hours: 38,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 12,
        used_hours: 50,
        time_on_demurrage_hours: 38,
        time_saved_hours: 0,
        demurrage_amount: 39583.33,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 3. Weather delay under WWDSHEX-EIU
  {
    name: "weather-delay-wwdshex-eiu",
    description:
      "WWDSHEX-EIU basis: weather delay 16:00-18:00 excluded. Allowed 4h. Demurrage starts at 20:00.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "3", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "WEATHER_DELAY" },
      { id: "4", occurred_at: iso("2024-03-04T18:00:00Z"), event_type: "WEATHER_DELAY_END" },
      { id: "5", occurred_at: iso("2024-03-04T18:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "6", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 4,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "WWDSHEX-EIU",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      // 14:00→16:00 laytime (2h, used 2)
      // 16:00→18:00 weather_delay (excluded)
      // 18:00→20:00 laytime (2h, used 4)
      // 20:00→next-day 08:00 demurrage (12h)
      // Total used = 16h
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-04T18:00:00Z"),
          duration_hours: 2,
          status: "weather_delay",
          counts: false,
          clause_ref: "GENCON94-6c",
          reasoning: "Weather working day excluded — weather delays excluded from laytime.",
        },
        {
          start_time: iso("2024-03-04T18:00:00Z"),
          end_time: iso("2024-03-04T20:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-04T20:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 12,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 4,
        used_hours: 16,
        time_on_demurrage_hours: 12,
        time_saved_hours: 0,
        demurrage_amount: 12000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 4a. WIBON shifting counts
  {
    name: "wibon-shifting-counts",
    description:
      "WIBON: shifting between NOR and ALL_FAST counts as laytime. 12h allowed, 18h total counting → demurrage starts at 02:00 next day (6h demurrage).",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "SHIFTING" },
      { id: "3", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "SHIFTING_END" },
      { id: "4", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "ALL_FAST" },
      { id: "5", occurred_at: iso("2024-03-04T17:00:00Z"), event_type: "HATCH_OPEN" },
      { id: "6", occurred_at: iso("2024-03-04T18:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "7", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      // Laytime commences 14:00. 14:00→16:00 shift counts (WIBON, used 2).
      // 16:00→next-day 02:00 laytime (10h, used 12).
      // 02:00→08:00 demurrage (6h, used 18).
      laytime_allowed_hours: 12,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHINC",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "shifting",
          counts: true,
          clause_ref: "GENCON94-6c",
          reasoning: "WIBON: shifting counts as laytime (NOR valid before berth).",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-05T02:00:00Z"),
          duration_hours: 10,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-05T02:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 6,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 12,
        used_hours: 18,
        time_on_demurrage_hours: 6,
        time_saved_hours: 0,
        demurrage_amount: 6000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 4b. WIPON shifting does NOT count
  {
    name: "wipon-shifting-does-not-count",
    description:
      "WIPON: shifting between NOR and ALL_FAST does NOT count. 12h allowed, 16h counting → demurrage starts at 04:00 next day (4h demurrage).",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "SHIFTING" },
      { id: "3", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "SHIFTING_END" },
      { id: "4", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "ALL_FAST" },
      { id: "5", occurred_at: iso("2024-03-04T17:00:00Z"), event_type: "HATCH_OPEN" },
      { id: "6", occurred_at: iso("2024-03-04T18:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "7", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 12,
      turn_time_hours: 6,
      nor_variant: "WIPON",
      days_basis: "SHINC",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      // 14:00→16:00 shift excluded (WIPON).
      // 16:00→next-day 04:00 laytime (12h, used 12).
      // 04:00→08:00 demurrage (4h, used 16).
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "shifting",
          counts: false,
          clause_ref: "GENCON94-6c",
          reasoning: "Non-WIBON: shifting does not count as laytime.",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-05T04:00:00Z"),
          duration_hours: 12,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-05T04:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 4,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 12,
        used_hours: 16,
        time_on_demurrage_hours: 4,
        time_saved_hours: 0,
        demurrage_amount: 4000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 5. Once-on-demurrage: weather and Sunday do not stop the clock
  {
    name: "once-on-demurrage-sunday-weather-do-not-stop",
    description:
      "Operations overrun allowed. Once on demurrage, weather and Sunday do not interrupt. SHINC basis.",
    events: [
      { id: "1", occurred_at: iso("2024-03-08T08:00:00Z"), event_type: "NOR_TENDERED" }, // Fri
      { id: "2", occurred_at: iso("2024-03-08T14:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "3", occurred_at: iso("2024-03-09T10:00:00Z"), event_type: "WEATHER_DELAY" },
      { id: "4", occurred_at: iso("2024-03-09T12:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "5", occurred_at: iso("2024-03-10T14:00:00Z"), event_type: "COMPLETED_LOADING" }, // Sun
    ],
    cpTerms: {
      // Laytime commences Fri 14:00. Allowed 2h.
      // Fri 14:00→16:00 laytime (2h, used 2).
      // Fri 16:00 → Sun 14:00 demurrage (46h, used 48).
      laytime_allowed_hours: 2,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHINC",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      breakdown: [
        {
          start_time: iso("2024-03-08T14:00:00Z"),
          end_time: iso("2024-03-08T16:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-08T16:00:00Z"),
          end_time: iso("2024-03-10T14:00:00Z"),
          duration_hours: 46,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 2,
        used_hours: 48,
        time_on_demurrage_hours: 46,
        time_saved_hours: 0,
        demurrage_amount: 46000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 6. Despatch scenario (operations complete early)
  {
    name: "despatch-operations-complete-early",
    description:
      "Allowed 24h, only 8h used → 16h time saved = despatch @ 12500/day = 8333.33.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "3", occurred_at: iso("2024-03-04T22:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 24,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "SHINC",
      demurrage_rate: 25000,
      despatch_rate: 12500,
      currency: "USD",
    },
    expected: {
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T22:00:00Z"),
          duration_hours: 8,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
      ],
      totals: {
        allowed_hours: 24,
        used_hours: 8,
        time_on_demurrage_hours: 0,
        time_saved_hours: 16,
        demurrage_amount: 0,
        despatch_amount: 8333.33,
        currency: "USD",
      },
    },
  },
  // 7. Weather delay with an explicit end, and an unrelated event logged
  //    mid-delay. Regression test for the bug where the engine used to treat
  //    "whatever event happens next" as the end of the delay — the BERTHED
  //    event at 17:00 must NOT cut the delay short; only WEATHER_DELAY_END does.
  {
    name: "weather-delay-not-cut-short-by-unrelated-event",
    description:
      "Weather delay 16:00-20:00 (explicit end). An unrelated BERTHED event fires at 17:00 mid-delay and must not end it early.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "3", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "WEATHER_DELAY" },
      { id: "4", occurred_at: iso("2024-03-04T17:00:00Z"), event_type: "BERTHED" },
      { id: "5", occurred_at: iso("2024-03-04T20:00:00Z"), event_type: "WEATHER_DELAY_END" },
      { id: "6", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 4,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "WWDSHEX-EIU",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      // 14:00-16:00 laytime (2h, used 2)
      // 16:00-20:00 weather_delay, excluded (BERTHED@17:00 does not end it)
      // 20:00-22:00 laytime (2h, used 4) -> allowed exhausted
      // 22:00 -> next-day 08:00 demurrage (10h, used 14)
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-04T20:00:00Z"),
          duration_hours: 4,
          status: "weather_delay",
          counts: false,
          clause_ref: "GENCON94-6c",
          reasoning: "Weather working day excluded — weather delays excluded from laytime.",
        },
        {
          start_time: iso("2024-03-04T20:00:00Z"),
          end_time: iso("2024-03-04T22:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-04T22:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 10,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 4,
        used_hours: 14,
        time_on_demurrage_hours: 10,
        time_saved_hours: 0,
        demurrage_amount: 10000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },

  // 8. Weather delay with NO end event at all: must conservatively run to
  //    windowEnd, not stop at the next unrelated event (the old bug's behavior).
  {
    name: "weather-delay-no-end-runs-to-window-end",
    description:
      "Weather delay logged with no WEATHER_DELAY_END. An unrelated BERTHED event follows an hour later but must not be treated as the delay's end — the delay must run all the way to the end of the operation.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "3", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "WEATHER_DELAY" },
      { id: "4", occurred_at: iso("2024-03-04T17:00:00Z"), event_type: "BERTHED" },
      { id: "5", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 4,
      turn_time_hours: 6,
      nor_variant: "WIBON",
      days_basis: "WWDSHEX-EIU",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      // 14:00-16:00 laytime (2h, used 2)
      // 16:00 -> completion: weather delay, unresolved, excluded for the rest
      // of the operation. Never reaches the 4h allowance, so despatch applies.
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 16,
          status: "weather_delay",
          counts: false,
          clause_ref: "GENCON94-6c",
          reasoning: "Weather working day excluded — weather delays excluded from laytime.",
        },
      ],
      totals: {
        allowed_hours: 4,
        used_hours: 2,
        time_on_demurrage_hours: 0,
        time_saved_hours: 2,
        demurrage_amount: 0,
        despatch_amount: 1000.00,
        currency: "USD",
      },
    },
  },

  // 9. Shifting with an explicit end, plus an unrelated HATCH_OPEN logged
  //    mid-shift (dangling, no HATCH_CLOSE) that must not interfere.
  {
    name: "shifting-paired-with-end-ignores-unrelated-event",
    description:
      "WIPON: shifting 14:00-16:00 with explicit SHIFTING_END. A HATCH_OPEN at 15:00 (never closed) must not affect the shifting window or the laytime count.",
    events: [
      { id: "1", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
      { id: "2", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "SHIFTING" },
      { id: "3", occurred_at: iso("2024-03-04T15:00:00Z"), event_type: "HATCH_OPEN" },
      { id: "4", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "SHIFTING_END" },
      { id: "5", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "ALL_FAST" },
      { id: "6", occurred_at: iso("2024-03-04T18:00:00Z"), event_type: "COMMENCED_LOADING" },
      { id: "7", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
    ],
    cpTerms: {
      laytime_allowed_hours: 12,
      turn_time_hours: 6,
      nor_variant: "WIPON",
      days_basis: "SHINC",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    },
    expected: {
      // 14:00-16:00 shifting excluded (WIPON, 2h)
      // 16:00 -> next-day 04:00 laytime (12h, used 12)
      // 04:00 -> 08:00 demurrage (4h, used 16)
      breakdown: [
        {
          start_time: iso("2024-03-04T14:00:00Z"),
          end_time: iso("2024-03-04T16:00:00Z"),
          duration_hours: 2,
          status: "shifting",
          counts: false,
          clause_ref: "GENCON94-6c",
          reasoning: "Non-WIBON: shifting does not count as laytime.",
        },
        {
          start_time: iso("2024-03-04T16:00:00Z"),
          end_time: iso("2024-03-05T04:00:00Z"),
          duration_hours: 12,
          status: "laytime",
          counts: true,
          clause_ref: "GENCON94-6",
          reasoning: "Laytime counting.",
        },
        {
          start_time: iso("2024-03-05T04:00:00Z"),
          end_time: iso("2024-03-05T08:00:00Z"),
          duration_hours: 4,
          status: "demurrage",
          counts: true,
          clause_ref: "GENCON94-8",
          reasoning:
            "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.",
        },
      ],
      totals: {
        allowed_hours: 12,
        used_hours: 16,
        time_on_demurrage_hours: 4,
        time_saved_hours: 0,
        demurrage_amount: 4000.00,
        despatch_amount: 0,
        currency: "USD",
      },
    },
  },
];

// === Test runner ===
describe("GENCON 94 laytime engine — table-driven fixtures", () => {
  for (const fx of fixtures) {
    it(`${fx.name}: ${fx.description}`, () => {
      const result = recomputeLaytime(fx.events, fx.cpTerms);
      expect(result).toEqual(fx.expected);
    });
  }
});

describe("GENCON 94 — error paths", () => {
  it("throws NO_NOR when no NOR_TENDERED event is present", () => {
    expect(() =>
      recomputeLaytime(
        [
          { id: "1", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
          { id: "2", occurred_at: iso("2024-03-04T22:00:00Z"), event_type: "COMPLETED_LOADING" },
        ],
        {
          laytime_allowed_hours: 24,
          turn_time_hours: 6,
          nor_variant: "WIBON",
          days_basis: "SHINC",
          demurrage_rate: 25000,
          despatch_rate: 12500,
          currency: "USD",
        }
      )
    ).toThrow(/NO_NOR/);
  });
});
