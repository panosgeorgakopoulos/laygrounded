// PLG self-serve onboarding & M2M telemetry — the pure halves.
//
// Two capabilities consolidated here, both feeding the /api/v1 surface:
//   * fixture-recap parsing — a deterministic, regex-based extractor that
//     turns the recap text a broker pastes at sign-up into CpTerms + claim
//     fields, so a tenant sees a working laytime dashboard before uploading
//     a single PDF. Deliberately NOT an AI call: onboarding must be instant,
//     free, and reproducible; anything the parser misses is reported in
//     `missing`/`warnings` and falls back to documented defaults the user
//     can edit in the workspace.
//   * telemetry validation — Zod schemas for the machine-to-machine endpoint
//     (IoT gantry cranes, autonomous vessel stacks) and the mapping from
//     validated readings to sof_events rows. Timestamps must carry an
//     explicit timezone — the same rule the AI extraction pipeline enforces.
//
// Pure module: no I/O, no Supabase; the routes own persistence.

import { z } from "zod";
import {
  DEFAULT_CP_TERMS,
  EVENT_TYPE_VALUES,
  type CpTerms,
  type DaysBasis,
  type EventTypeEnum,
  type NorVariant,
} from "@/lib/laytime/types";

// === Fixture recap parsing ===

export interface RecapClaimFields {
  vessel: string | null;
  port: string | null;
  cargo: string | null;
  voyageRef: string | null;
  counterpartyName: string | null;
}

export interface RecapParseResult {
  claim: RecapClaimFields;
  cpTerms: CpTerms;
  matched: string[]; // which fields the parser actually found
  missing: string[]; // fields that fell back to defaults
  warnings: string[];
}

// Longest-token-first so "SSHEX UU" never half-matches as "SHEX".
const DAYS_BASIS_TOKENS: Array<[string, DaysBasis]> = [
  ["WWDSSHEX EIU", "WWDSSHEX-EIU"],
  ["SSHEX EIU", "WWDSSHEX-EIU"],
  ["SSHEX UU", "SSHEX-UU"],
  ["SSHEX", "SSHEX"],
  ["WWDSHEX EIU", "WWDSHEX-EIU"],
  ["SHEX EIU", "WWDSHEX-EIU"],
  ["SHEX UU", "SHEX-UU"],
  ["SHEX", "SHEX"],
  ["SHINC", "SHINC"],
];

const NOR_TOKENS: NorVariant[] = ["WIBON", "WIPON", "WICCON", "WIFPON"];

const LABEL_ALIASES: Record<string, keyof RecapClaimFields> = {
  VESSEL: "vessel",
  SHIP: "vessel",
  MV: "vessel",
  PORT: "port",
  "LOAD PORT": "port",
  LOADPORT: "port",
  "DISCH PORT": "port",
  "DISCHARGE PORT": "port",
  DISPORT: "port",
  CARGO: "cargo",
  VOYAGE: "voyageRef",
  VOY: "voyageRef",
  REF: "voyageRef",
  "CP REF": "voyageRef",
  CHARTERER: "counterpartyName",
  CHARTERERS: "counterpartyName",
  CHTRS: "counterpartyName",
  COUNTERPARTY: "counterpartyName",
};

const num = (s: string) => parseFloat(s.replace(/,/g, ""));

// Deterministic recap → claim + CpTerms. Throws "RECAP_UNPARSEABLE" when not
// a single field could be extracted (arbitrary prose, wrong document).
export function parseFixtureRecap(text: string): RecapParseResult {
  const matched: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  const claim: RecapClaimFields = {
    vessel: null,
    port: null,
    cargo: null,
    voyageRef: null,
    counterpartyName: null,
  };

  // 1. Labeled "KEY: value" lines — the strongest signal.
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]{0,20}?)\s*[:=]\s*(.+?)\s*$/);
    if (!m) continue;
    const field = LABEL_ALIASES[m[1].trim().toUpperCase()];
    if (field && !claim[field]) claim[field] = m[2].trim().slice(0, 120);
  }

  // 2. Prefix fallback for the vessel ("MV IRON DUKE / 72000 MT ...").
  if (!claim.vessel) {
    const m = text.match(/\b(?:MV|M\/V|MT|M\/T)\.?\s+([A-Z][A-Z0-9.'-]*(?:\s+[A-Z][A-Z0-9.'-]*){0,3})/);
    if (m) claim.vessel = m[1].trim();
  }

  // Token scans run on a normalized copy (punctuation → spaces).
  const upper = text.toUpperCase().replace(/[^A-Z0-9$.,/]+/g, " ");

  const terms: CpTerms = { ...DEFAULT_CP_TERMS };

  // 3. Days basis.
  const basisHit = DAYS_BASIS_TOKENS.find(([token]) => upper.includes(token));
  if (basisHit) {
    terms.days_basis = basisHit[1];
    matched.push("days_basis");
  } else {
    missing.push("days_basis");
  }

  // 4. NOR variant.
  const norHit = NOR_TOKENS.find((t) => upper.includes(t));
  if (norHit) {
    terms.nor_variant = norHit;
    matched.push("nor_variant");
  } else {
    missing.push("nor_variant");
  }

  // 5. CP form.
  if (upper.includes("ASBATANKVOY")) {
    terms.cp_form = "ASBATANKVOY";
    matched.push("cp_form");
  } else if (upper.includes("GENCON")) {
    terms.cp_form = "GENCON94";
    matched.push("cp_form");
  }

  // 6. Laytime allowance: explicit hours, else derivable from rate + quantity.
  const laytimeHours =
    text.match(/LAYTIME[^\n]*?([\d,]+(?:\.\d+)?)\s*(?:HRS|HOURS)/i) ??
    text.match(/([\d,]+(?:\.\d+)?)\s*(?:HRS|HOURS)[^\n]*?LAYTIME/i) ??
    text.match(/([\d,]+(?:\.\d+)?)\s*(?:HRS|HOURS)\s+(?:TOTAL|ALL PURPOSES|ALLPURPOSES|REVERSIBLE)/i);
  const cargoQty = text.match(/([\d,]{3,})\s*MT[S]?\b/i);
  const loadRate = text.match(/([\d,]+)\s*MT[S]?\s*(?:PWWD|PER\s+(?:WWD|DAY)|PD|DAILY)/i);

  if (laytimeHours) {
    terms.laytime_allowed_hours = num(laytimeHours[1]);
    matched.push("laytime_allowed_hours");
  } else if (cargoQty && loadRate && num(loadRate[1]) > 0) {
    terms.laytime_allowed_hours =
      Math.round((num(cargoQty[1]) / num(loadRate[1])) * 24 * 100) / 100;
    terms.load_rate = num(loadRate[1]);
    matched.push("laytime_allowed_hours");
    warnings.push(
      `Laytime derived from ${cargoQty[1]} MT at ${loadRate[1]} MT/day — confirm against the CP.`
    );
  } else {
    missing.push("laytime_allowed_hours");
  }

  // 7. Turn time.
  const turn = text.match(/TURN\s*TIME[^\n]*?([\d.]+)\s*(?:HRS|HOURS)/i);
  if (turn) {
    terms.turn_time_hours = num(turn[1]);
    matched.push("turn_time_hours");
  }

  // 8. Demurrage / despatch. A currency marker or PDPR context is required —
  // a bare number in a recap is more likely a quantity than a rate.
  const dem = text.match(
    /\bDEM(?:URRAGE)?\b[^\n]{0,40}?(USD|US\$|\$|EUR|€)\s?([\d,]+(?:\.\d+)?)/i
  );
  if (dem) {
    terms.demurrage_rate = num(dem[2]);
    terms.currency = dem[1].toUpperCase().startsWith("E") || dem[1] === "€" ? "EUR" : "USD";
    matched.push("demurrage_rate");
  } else {
    missing.push("demurrage_rate");
  }

  const desp = text.match(/\bDESP(?:ATCH)?\b[^\n]{0,40}?(?:USD|US\$|\$|EUR|€)\s?([\d,]+(?:\.\d+)?)/i);
  if (desp) {
    terms.despatch_rate = num(desp[1]);
    matched.push("despatch_rate");
  } else if (/\b(?:DHD|HDWTS|HD)\b/i.test(text) && dem) {
    terms.despatch_rate = terms.demurrage_rate / 2;
    matched.push("despatch_rate");
    warnings.push("Despatch set to half demurrage (HD term detected).");
  }

  // 9. Cargo fallback from "72,000 MT IRON ORE".
  if (!claim.cargo && cargoQty) {
    const m = text.match(/[\d,]{3,}\s*MT[S]?\s+(?:OF\s+)?([A-Za-z][A-Za-z ]{2,40})/i);
    if (m) claim.cargo = m[1].trim();
  }

  for (const [field, value] of Object.entries(claim)) {
    if (value) matched.push(field);
    else missing.push(field);
  }

  if (matched.length === 0) throw new Error("RECAP_UNPARSEABLE");
  for (const f of missing) {
    if (f in DEFAULT_CP_TERMS) {
      warnings.push(`No ${f} found — using the default (${String(DEFAULT_CP_TERMS[f as keyof CpTerms])}); edit in the workspace.`);
    }
  }

  return { claim, cpTerms: terms, matched, missing, warnings };
}

// === M2M telemetry ===

// Explicit-timezone rule, same as the AI extraction pipeline: a naive
// timestamp from a sensor in an unknown locale is worse than no data.
export const TZ_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

export const TelemetryReadingSchema = z.object({
  reading_id: z.string().min(1).max(128),
  event_type: z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]),
  occurred_at: z
    .string()
    .refine((s) => TZ_OFFSET_RE.test(s) && !Number.isNaN(Date.parse(s)), {
      message: "occurred_at must be ISO 8601 with an explicit timezone offset",
    }),
  // Device identity: "gantry-crane-4", "bridge-ais-stack", …
  source: z.string().min(1).max(120),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const TelemetryBatchSchema = z.object({
  batch_id: z.string().min(1).max(128), // idempotency key for the delivery
  external_ref: z.string().min(1).max(200), // voyage identity at the sender
  vessel: z.string().min(1).max(120).optional(),
  port: z.string().min(1).max(120).optional(),
  readings: z.array(TelemetryReadingSchema).min(1).max(200),
});

export type TelemetryReading = z.infer<typeof TelemetryReadingSchema>;
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

// Validated readings → sof_events rows. Machine events arrive confirmed
// (status 'accepted'): the sender is a permissioned, HMAC-authenticated
// device feed, which is exactly the trust level the human review queue
// exists to establish for AI-extracted events.
export function telemetryToSofEventRows(
  claimId: string,
  documentId: string,
  readings: TelemetryReading[]
): Array<Record<string, unknown>> {
  return readings.map((r) => ({
    claim_id: claimId,
    document_id: documentId,
    occurred_at: r.occurred_at,
    event_type: r.event_type,
    raw_text: `M2M ${r.source}: ${r.event_type} at ${r.occurred_at} (reading ${r.reading_id})`,
    page: 1,
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    confidence: 1.0,
    source: "m2m",
    status: "accepted",
  }));
}
