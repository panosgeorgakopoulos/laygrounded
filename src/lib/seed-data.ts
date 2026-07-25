// Demo seed data. The scenarios themselves live in seed-data.generated.ts,
// curated from the engine-validated synthetic corpus by
// scripts/seed/build-demo-dataset.ts (run `bun run seed:dataset`). This file
// owns only the types and re-exports the generated book, so the demo is
// realistic, varied and reliable rather than three hand-written claims.

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
  // Valid 7-digit IMO (ISO check digit), so sanctions screening and the
  // vessel identity read as real.
  vesselImo: string;
  voyageRef: string;
  port: string;
  cargo: string;
  counterpartyName: string;
  cpForm: "GENCON94" | "ASBATANKVOY";
  cpTerms: CpTerms;
  // Contractual time-bar window in days (default 90).
  timeBarDays: number;
  // The last event is shifted to ≈ now − recencyDays (whole weeks, so weekday
  // alignment is preserved for SHEX/SSHEX bases), giving live time-bar states.
  recencyDays: number;
  // EU ETS scope: true (EEA port), false (non-EEA), or null (unknown).
  etsApplicable: boolean | null;
  archetype: string;
  description: string;
  // Seed a weather evidence verdict to light up the evidence panel and, when
  // 'contradicted', the in-voyage Legal Shield.
  weatherVerdict: "corroborated" | "contradicted" | null;
  events: SeedEvent[];
}

export { seedScenarios } from "./seed-data.generated";
