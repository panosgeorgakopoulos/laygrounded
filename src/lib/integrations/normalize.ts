// Field normalizers shared by every ERP adapter.
//
// These exist as one implementation rather than three because the failure they
// prevent is silent: an ERP that returns "" for an unset ETA, an adapter that
// coerces it, and a fabricated timestamp reaching the risk engine looking like
// a measurement. Each function below turns "the ERP did not say" into `null`,
// and never into a plausible-looking default.

import type { NormalizedSchedule } from "./types";

/**
 * A timestamp, or null when the ERP has no value.
 *
 * Empty strings, whitespace, and unparseable text all become `null`. An
 * unparseable date is NOT passed through as a string: downstream code types
 * these fields as ISO instants, and a value like "TBA" reaching `new Date()`
 * yields Invalid Date at a point far from the adapter that produced it.
 */
export function nullableTime(raw: unknown): string | null {
  if (typeof raw !== "string") {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const t = new Date(trimmed);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** A finite number, or null. Rejects NaN and Infinity, not just non-numbers. */
export function finiteOrNull(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The purpose of a port call.
 *
 * Matched on a normalised prefix because every ERP spells these differently
 * ("LOAD", "Loading", "L", "load_port"). Anything unrecognised is `unknown`,
 * which is a real state — guessing "load" would misattribute the laytime
 * regime of the call.
 */
export function mapPortFunction(raw: unknown): NormalizedSchedule["portFunction"] {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toUpperCase();
  if (!v) return "unknown";
  if (v.startsWith("L")) return "load";
  if (v.startsWith("D") || v.startsWith("U")) return "discharge"; // Discharge / Unload
  if (v.startsWith("B")) return "bunker";
  if (v.startsWith("T") || v.startsWith("C")) return "transit"; // Transit / Canal
  return "unknown";
}

/**
 * An inbound webhook's event type, reduced to the closed set the sync engine
 * acts on.
 *
 * Accepts the three spellings these products use — `voyage.created`,
 * `VOYAGE_CREATED`, `VoyageCreated` — and collapses everything else to
 * `unknown`. `unknown` is not a rejection: the webhook route still ledgers the
 * delivery, it simply performs no voyage upsert. Acting on an event type we do
 * not recognise is how an unrelated ERP notification becomes a claim.
 */
export function mapEventType(raw: unknown): "voyage.created" | "voyage.updated" | "unknown" {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase().replace(/[_\s-]/g, "");
  if (v === "voyage.created" || v === "voyagecreated") return "voyage.created";
  if (v === "voyage.updated" || v === "voyageupdated" || v === "voyagechanged") {
    return "voyage.updated";
  }
  return "unknown";
}
