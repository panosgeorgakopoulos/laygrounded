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
import type { CpTerms, EngineVersion, SofEventInput } from "./types";

export const ENGINE_NAME = "@laygrounded/laytime-core";
/** The PACKAGE release. Not the rule set — that is `EngineVersion` in types.ts. */
export const ENGINE_VERSION = "0.1.0";

/**
 * Canary voyages, chosen to touch the branches that actually decide money:
 * SHEX weekend exclusion, WWD weather exclusion, a holiday from a port calendar,
 * ASBATANKVOY's separate regime, despatch, and the NOR error path.
 *
 * These are FROZEN. Adding one changes every fingerprint, so the set is part of
 * the format rather than a convenience. A new rule set may APPEND its own
 * canaries (see `V2_CANARY_TERMS`) precisely because appending leaves the older
 * version's material untouched.
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

/**
 * The v2-only canaries.
 *
 * v2's single behavioural change is invisible to the frozen set above — none of
 * those voyages logs an agreed excepted period — so fingerprinting v2 on them
 * alone would produce material identical to v1's and assert that two engines
 * computing different money are the same engine. These exercise the branch that
 * actually moved.
 *
 * They are appended, never interleaved, so the v1 lines stay byte-identical.
 * 2026-03-08 is a Sunday in Europe/Amsterdam, which is the point: under SHINC
 * the Sunday counts, and the agreed exception laid over it must not.
 */
const V2_CANARY_EVENTS: SofEventInput[] = [
  ...CANARY_EVENTS,
  { id: "g", occurred_at: "2026-03-08T04:00:00Z", event_type: "EXCEPTED_PERIOD_START" },
  { id: "h", occurred_at: "2026-03-08T22:00:00Z", event_type: "EXCEPTED_PERIOD_END" },
];

// The generous allowance is the whole trick. CANARY_BASE allows 48 hours, which
// this voyage exhausts BEFORE the excepted period begins — and once on
// demurrage, Cl. 8 counts every hour regardless, so the branch v2 changes is
// never reached. Canaries built that way would produce material identical to
// v1's and assert that two engines computing different money are the same
// engine. Caught by `engine-version.test.ts`, which is why that test asserts on
// the canary CONTENT and not merely that the two strings differ.
const V2_CANARY_TERMS: CpTerms[] = [
  { ...CANARY_BASE, days_basis: "SHINC", laytime_allowed_hours: 240 },
  // The same voyage under SHEX: proves v2 left the branch that already worked
  // alone, rather than merely proving something changed somewhere.
  { ...CANARY_BASE, days_basis: "SHEX", laytime_allowed_hours: 240 },
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
export function engineFingerprintMaterial(engineVersion: EngineVersion = 1): string {
  // Rule set 1 must produce EXACTLY the bytes it always has: notarised
  // derivation records already commit to the hash of this string, and a claim
  // whose engine leaf stopped matching would read as tampered-with. So v1 emits
  // no version line at all — its absence is its identity, the same convention
  // `engine_version` itself uses.
  const versioned = engineVersion >= 2;
  const lines: string[] = [
    `engine|${ENGINE_NAME}@${ENGINE_VERSION}`,
    ...(versioned ? [`rules|${engineVersion}`] : []),
    `tzdata|${TZDATA_DIGEST}`,
  ];

  const stamp = (terms: CpTerms): CpTerms =>
    versioned ? { ...terms, engine_version: engineVersion } : terms;

  CANARY_TERMS.forEach((terms, i) => {
    try {
      lines.push(`canary-${i}|${stableJson(recomputeLaytime(CANARY_EVENTS, stamp(terms)))}`);
    } catch (e) {
      lines.push(`canary-${i}|error:${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // The NOR error path.
  try {
    recomputeLaytime(
      CANARY_EVENTS.filter((e) => e.event_type !== "NOR_TENDERED"),
      stamp(CANARY_BASE),
    );
    lines.push("canary-nonor|UNEXPECTED_SUCCESS");
  } catch (e) {
    lines.push(`canary-nonor|${e instanceof Error ? e.message : String(e)}`);
  }

  if (versioned) {
    V2_CANARY_TERMS.forEach((terms, i) => {
      try {
        lines.push(`v2-canary-${i}|${stableJson(recomputeLaytime(V2_CANARY_EVENTS, stamp(terms)))}`);
      } catch (e) {
        lines.push(`v2-canary-${i}|error:${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return lines.join("\n");
}
