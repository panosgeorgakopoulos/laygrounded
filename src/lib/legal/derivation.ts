// Assembles the DerivationRecord that a notarized snapshot commits to.
//
// Kept out of prosecution.ts because it reaches into the engine package for the
// pinned timezone table and the behavioural fingerprint; prosecution.ts stays a
// pure hashing module.

import { createHash } from "node:crypto";
import {
  ENGINE_NAME,
  ENGINE_VERSION,
  engineFingerprintMaterial,
} from "@laygrounded/laytime-core/fingerprint";
import {
  TZ_TRANSITIONS,
  TZDATA_DIGEST,
  TZDATA_ERA_START_SEC,
  TZDATA_ERA_END_SEC,
} from "@laygrounded/laytime-core/tzdata";
import type { DerivationRecord } from "@/lib/legal/prosecution";
import type { SofEventInput } from "@/lib/laytime/types";

/**
 * The engine's total-order rule, stated so a third party can reimplement it.
 *
 * Kept in step with `canonicalEventOrder` in the engine. It is named rather than
 * merely applied because the ordering of same-instant events changes the result,
 * and an auditor reproducing the calculation needs the rule, not just the
 * outcome.
 */
export const ORDERING_RULE = "occurred_at ASC, terminators-before-initiators, event_type ASC, id ASC";

let cachedFingerprint: string | null = null;

/**
 * SHA-256 over the engine's canary material. Computed once per process — it is
 * deterministic, so recomputing it per claim would be pure waste.
 */
export function engineFingerprint(): string {
  if (cachedFingerprint === null) {
    cachedFingerprint = createHash("sha256")
      .update(engineFingerprintMaterial())
      .digest("hex");
  }
  return cachedFingerprint;
}

/**
 * Builds the derivation record for one calculation.
 *
 * `events` must be the events AS THE ENGINE ORDERED THEM, not as they were
 * fetched — the record's whole purpose is to pin the ordering actually used.
 */
export function buildDerivationRecord(
  events: SofEventInput[],
  portTimezone: string | null | undefined,
): DerivationRecord {
  const zone = portTimezone && portTimezone.trim() ? portTimezone.trim() : "UTC";
  // Only THIS claim's zone travels in the bundle. Shipping all 463 would bloat
  // every proof to no purpose; shipping none would put the auditor back on their
  // own ICU, which is exactly what this record exists to avoid.
  const transitions = TZ_TRANSITIONS[zone] ?? [];

  return {
    engine: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      fingerprint: engineFingerprint(),
    },
    tzdata: {
      digest: TZDATA_DIGEST,
      zone: portTimezone && portTimezone.trim() ? portTimezone.trim() : null,
      transitions,
      eraStartSec: TZDATA_ERA_START_SEC,
      eraEndSec: TZDATA_ERA_END_SEC,
    },
    ordering: {
      rule: ORDERING_RULE,
      eventIds: events.map((e) => e.id),
    },
  };
}
