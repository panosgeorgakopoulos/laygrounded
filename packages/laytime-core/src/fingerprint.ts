// A fingerprint of what this engine DOES, for provenance.
//
// The obvious approach — hash the engine's source text — is worse than it looks.
// It changes when a comment is reworded and does NOT change when a dependency
// underneath shifts behaviour, so it answers a question nobody asked ("was this
// file edited?") instead of the one that matters ("does this compute the same
// numbers?").
//
// So the fingerprint is behavioural: a fixed set of canary voyages is run
// through the engine and the canonical results are the material. It moves
// exactly when a laytime figure would move, which is the property a notarized
// derivation record needs. The pinned timezone digest is mixed in for the same
// reason — a different table is a different engine as far as the answer is
// concerned, even with identical code.
//
// No hashing here: laytime-core must stay dependency-free so it runs unchanged
// in Node, Bun, browsers and WebAssembly. The caller applies its own SHA-256 to
// the material this returns.

import { recomputeLaytime } from "./gencon94";
import { TZDATA_DIGEST } from "./tzdata";
import type { CpTerms, SofEventInput } from "./types";

export const ENGINE_NAME = "@laygrounded/laytime-core";
export const ENGINE_VERSION = "0.1.0";

/**
 * Canary voyages, chosen to touch the branches that actually decide money:
 * SHEX weekend exclusion, WWD weather exclusion, a holiday from a port calendar,
 * ASBATANKVOY's separate regime, despatch, and the NOR error path.
 *
 * These are FROZEN. Adding one changes every fingerprint, so the set is part of
 * the format rather than a convenience.
 */
const CANARY_EVENTS: SofEventInput[] = [
  { id: "a", occurred_at: "2026-03-05T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "b", occurred_at: "2026-03-05T14:00:00Z", event_type: "ALL_FAST" },
  { id: "c", occurred_at: "2026-03-05T16:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "d", occurred_at: "2026-03-07T08:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "e", occurred_at: "2026-03-07T20:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "f", occurred_at: "2026-03-10T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

const CANARY_BASE: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 48,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHEX",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
};

const CANARY_TERMS: CpTerms[] = [
  CANARY_BASE,
  { ...CANARY_BASE, days_basis: "SHINC" },
  { ...CANARY_BASE, days_basis: "WWDSHEX-EIU" },
  { ...CANARY_BASE, days_basis: "SSHEX", port_timezone: "Asia/Singapore" },
  { ...CANARY_BASE, cp_form: "ASBATANKVOY" },
  // Generous allowance so despatch, not demurrage, is exercised.
  { ...CANARY_BASE, laytime_allowed_hours: 240 },
  // A port-calendar holiday mid-voyage: proves the calendar path is in the mix.
  {
    ...CANARY_BASE,
    port_calendar: { holidays: ["2026-03-09"], source: "fingerprint canary" },
  },
];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The material to hash. Deterministic, and identical in every runtime.
 *
 * Includes the error path deliberately: an engine that stopped rejecting a
 * NOR-less timeline is a different engine, and a fingerprint that ignored that
 * would say otherwise.
 */
export function engineFingerprintMaterial(): string {
  const lines: string[] = [
    `engine|${ENGINE_NAME}@${ENGINE_VERSION}`,
    `tzdata|${TZDATA_DIGEST}`,
  ];

  CANARY_TERMS.forEach((terms, i) => {
    try {
      lines.push(`canary-${i}|${stableJson(recomputeLaytime(CANARY_EVENTS, terms))}`);
    } catch (e) {
      lines.push(`canary-${i}|error:${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // The NOR error path.
  try {
    recomputeLaytime(
      CANARY_EVENTS.filter((e) => e.event_type !== "NOR_TENDERED"),
      CANARY_BASE,
    );
    lines.push("canary-nonor|UNEXPECTED_SUCCESS");
  } catch (e) {
    lines.push(`canary-nonor|${e instanceof Error ? e.message : String(e)}`);
  }

  return lines.join("\n");
}
