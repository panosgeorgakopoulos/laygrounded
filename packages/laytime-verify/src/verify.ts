// The offline verifier: re-run a laytime calculation from a signed bundle and
// say whether the published figures follow from the published facts.
//
// The point is that an arbitrator, a P&I club or a lender can check a claim
// WITHOUT trusting LayGrounded's servers, our uptime, or our continued
// existence. Everything needed is in the bundle plus this artifact; there is no
// network call and no configuration.
//
// Two properties make that possible, and both were deliberate:
//   * the engine is pure — no I/O, no clock, no randomness;
//   * timezones resolve from a pinned table rather than the host's ICU, so the
//     answer cannot drift when a runtime ships new tzdata.
//
// Pure. The entrypoints do the I/O.

import { recomputeLaytime, NoNorError } from "@laygrounded/laytime-core/gencon94";
import { TZDATA_DIGEST } from "@laygrounded/laytime-core/tzdata";
import type { CpTerms, LaytimeResult, SofEventInput } from "@laygrounded/laytime-core/types";

export const VERIFIER_VERSION = "1.0.0";

/**
 * Canonical JSON: keys sorted at every level, no incidental whitespace,
 * `undefined` dropped.
 *
 * Digests must be a property of the DATA, not of how some serializer happened
 * to order keys. Mirrors `canonicalJson` in src/lib/legal/prosecution.ts — the
 * app and the verifier must agree byte for byte or every root would mismatch.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/** FNV-1a over UTF-8. Not cryptographic — an integrity check for the conformance
 *  root, chosen so the artifact needs no hash implementation of its own. The
 *  claim bundle's authenticity rests on the RFC-3161 anchor, not on this. */
export function digestHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export interface ConformanceCase {
  id: string;
  cpTerms: CpTerms;
  events: SofEventInput[];
  expected: { result?: LaytimeResult; error?: string };
}

export type CaseOutcome =
  | { id: string; ok: true; digest: string }
  | { id: string; ok: false; digest: string; reason: string };

/**
 * Replays one case and reports whether it reproduced the published expectation.
 *
 * Error cases are as much a part of the contract as successful ones: an engine
 * that stopped rejecting a NOR-less timeline would be just as broken as one that
 * returned wrong money.
 */
export function runCase(c: ConformanceCase): CaseOutcome {
  let actual: LaytimeResult | null = null;
  let error: string | null = null;

  try {
    actual = recomputeLaytime(c.events, c.cpTerms);
  } catch (e) {
    error = e instanceof NoNorError ? "NO_NOR" : e instanceof Error ? e.message : String(e);
  }

  const digest = digestHex(canonicalJson(error !== null ? { error } : actual));

  if (c.expected.error !== undefined) {
    // The corpus records a sentinel PREFIX ("MULTIPLE_NOR"), while the engine
    // throws that sentinel followed by prose. Matching on the prefix is the
    // convention regression.test.ts already uses, and it is the right one: the
    // sentinel is the contract, the prose is a message that may be reworded
    // without changing behaviour.
    const matched = error !== null && error.startsWith(c.expected.error);
    return matched
      ? { id: c.id, ok: true, digest }
      : {
          id: c.id,
          ok: false,
          digest,
          reason: `expected error ${c.expected.error}, got ${error ?? "success"}`,
        };
  }

  if (error !== null) {
    return { id: c.id, ok: false, digest, reason: `unexpected error: ${error}` };
  }

  const expectedCanonical = canonicalJson(c.expected.result);
  const actualCanonical = canonicalJson(actual);
  return expectedCanonical === actualCanonical
    ? { id: c.id, ok: true, digest }
    : { id: c.id, ok: false, digest, reason: "result differs from the published golden" };
}

export interface ConformanceReport {
  verifierVersion: string;
  tzdataDigest: string;
  cases: number;
  passed: number;
  failed: number;
  /**
   * Digest over every case's COMPUTED output, in id order.
   *
   * This fingerprints what the artifact DOES, not whether it agreed with the
   * goldens — that is `failed`. The distinction is deliberate and load-bearing:
   * two artifacts (the readable .mjs and the sealed .wasm) matching on this root
   * proves they compute identically, which is a claim about the artifacts. Had
   * the root folded in the expectations, two artifacts could match merely by
   * both failing the same way.
   */
  root: string;
  failures: Array<{ id: string; reason: string }>;
}

/**
 * Runs the whole conformance suite.
 *
 * A third party runs this BEFORE trusting the verifier on their own claim: if
 * the artifact reproduces 500 published cases, its agreement on the 501st means
 * something. That self-certification is the artifact's whole standing.
 */
export function runConformance(cases: ConformanceCase[]): ConformanceReport {
  const ordered = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const outcomes = ordered.map(runCase);
  const failures = outcomes
    .filter((o): o is Extract<CaseOutcome, { ok: false }> => !o.ok)
    .map((o) => ({ id: o.id, reason: o.reason }));

  return {
    verifierVersion: VERIFIER_VERSION,
    tzdataDigest: TZDATA_DIGEST,
    cases: ordered.length,
    passed: outcomes.length - failures.length,
    failed: failures.length,
    root: digestHex(outcomes.map((o) => `${o.id}:${o.digest}`).join("\n")),
    failures,
  };
}

export interface ClaimBundle {
  claim?: { vessel?: string; voyageRef?: string; port?: string };
  cpTerms: CpTerms;
  events: SofEventInput[];
  /** The figures as published by whoever is asserting the claim. */
  published?: LaytimeResult;
}

export interface ClaimVerdict {
  verifierVersion: string;
  tzdataDigest: string;
  /** What the engine computes from the bundle's own facts. */
  recomputed: LaytimeResult | null;
  error: string | null;
  /** null when the bundle published nothing to compare against. */
  matchesPublished: boolean | null;
  /** Set only on a mismatch — the specific figures that disagree. */
  discrepancies?: Array<{ field: string; published: unknown; recomputed: unknown }>;
}

/**
 * Verifies one claim bundle.
 *
 * Reports the recomputed figures whether or not they match, and names the
 * specific discrepancies — "does not verify" is not useful to a tribunal
 * without saying which number is wrong and by how much.
 */
export function verifyClaim(bundle: ClaimBundle): ClaimVerdict {
  let recomputed: LaytimeResult | null = null;
  let error: string | null = null;

  try {
    recomputed = recomputeLaytime(bundle.events, bundle.cpTerms);
  } catch (e) {
    error = e instanceof NoNorError ? "NO_NOR" : e instanceof Error ? e.message : String(e);
  }

  if (!bundle.published || !recomputed) {
    return {
      verifierVersion: VERIFIER_VERSION,
      tzdataDigest: TZDATA_DIGEST,
      recomputed,
      error,
      matchesPublished: null,
    };
  }

  const matches =
    canonicalJson(bundle.published) === canonicalJson(recomputed);

  const discrepancies: ClaimVerdict["discrepancies"] = [];
  if (!matches) {
    const pub = bundle.published.totals as unknown as Record<string, unknown>;
    const rec = recomputed.totals as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(pub), ...Object.keys(rec)])) {
      if (canonicalJson(pub[key]) !== canonicalJson(rec[key])) {
        discrepancies.push({ field: `totals.${key}`, published: pub[key], recomputed: rec[key] });
      }
    }
    if (bundle.published.breakdown.length !== recomputed.breakdown.length) {
      discrepancies.push({
        field: "breakdown.length",
        published: bundle.published.breakdown.length,
        recomputed: recomputed.breakdown.length,
      });
    }
  }

  return {
    verifierVersion: VERIFIER_VERSION,
    tzdataDigest: TZDATA_DIGEST,
    recomputed,
    error,
    matchesPublished: matches,
    ...(matches ? {} : { discrepancies }),
  };
}
