// The verification package a trade-finance counterparty redeems a grant for.
//
// The point of this shape is what it does NOT ask the bank to believe. It does
// not say "the demurrage is USD 58,333.33, trust us". It ships the FACTS —
// charterparty terms and the confirmed event timeline — plus the figures we
// published from them, plus the fingerprint of the engine that produced them.
// The bank runs that engine itself, offline, against those facts, and compares.
//
// A credit committee can act on "we recomputed it and got the same number".
// It cannot act on a vendor's assertion, which is why every competitor's
// integration stops at a PDF.
//
// Pure: the caller loads the rows, this arranges them. No I/O, so the exact
// bytes a bank receives are testable.

import type { CpTerms, LaytimeResult, SofEventInput } from "@/lib/laytime/types";

/** Fingerprint of the verifier the bank should run. Straight from its manifest. */
export interface VerifierDescriptor {
  version: string;
  tzdataDigest: string;
  wasmSha256: string;
  mjsSha256: string;
  conformanceCases: number;
  conformanceRoot: string;
  /**
   * Which conformance bundle to run. Rule sets have separate suites and separate
   * roots, so naming the file is what stops a counterparty running the wrong one
   * and believing they attested the engine behind this claim.
   */
  conformanceFile: string;
}

export interface NotarizationDescriptor {
  /** Hash of the claim state at the time it was anchored. */
  digest: string;
  algorithm: string;
  anchoredAt: string;
  /** RFC-3161 authority, when one was used. */
  authority: string | null;
}

/**
 * The figures as persisted for this claim — a complete `LaytimeResult`.
 *
 * This used to be a named SUBSET, because `laytime_calculations` stored only
 * five of the engine's totals and a partial object presented as a whole one
 * would make a good claim report "does not verify". All the totals are now
 * persisted, so the package ships the whole result and the verifier does the
 * whole-object comparison it was always built for.
 *
 * The reconstruction is exact, including the ASBATANKVOY-only
 * `demurrage_half_rate_hours` key, whose presence must match the engine's —
 * see `calculationRowToResult`.
 */
export type PublishedFigures = LaytimeResult;

export interface VerificationPackageInput {
  claim: {
    id: string;
    vessel: string;
    voyageRef: string;
    port: string;
    cargo: string;
  };
  cpTerms: CpTerms;
  events: SofEventInput[];
  /** Persisted figures, or null when the claim has not been computed. */
  publishedFigures: PublishedFigures | null;
  notarization: NotarizationDescriptor | null;
  verifier: VerifierDescriptor;
  /**
   * The grant this package was redeemed against, or NULL when the claim owner
   * exported it themselves.
   *
   * Null is a meaningful state, not a missing field: it says nobody presented a
   * token for this copy, so there is no expiry, no access count and no
   * institution it was scoped to. The alternative — synthesising a grant
   * descriptor for a self-export — would put a fabricated authorisation record
   * into a document a bank reads as evidence.
   */
  grant?: {
    institutionLabel: string;
    purpose: string;
    expiresAt: string;
    accessCount: number;
  } | null;
}

export interface VerificationPackage {
  format: "laygrounded.claim-verification";
  /**
   * 1.1 — `bundle.published` now carries the whole persisted `LaytimeResult`,
   * so the verifier returns a real `matchesPublished` boolean. 1.0 shipped a
   * named subset in `publishedFigures` and a `comparableFields` mapping,
   * because three of the engine's totals were not persisted; both are gone.
   */
  formatVersion: "1.1";
  issuedAt: string;
  claim: VerificationPackageInput["claim"];
  /**
   * Exactly the shape `verifyClaim()` in @laygrounded/laytime-verify consumes.
   *
   * `published` is included whenever the claim has been computed, so the
   * verifier performs its whole-object comparison and reports
   * `matchesPublished` plus any specific discrepancies. When the claim has not
   * been computed there is nothing to compare and the key is absent, which the
   * verifier reports as `matchesPublished: null`.
   */
  bundle: {
    claim: { vessel: string; voyageRef: string; port: string };
    cpTerms: CpTerms;
    events: SofEventInput[];
    published?: PublishedFigures;
  };
  /** The same object as `bundle.published`, surfaced for readers. */
  publishedFigures: PublishedFigures | null;
  notarization: NotarizationDescriptor | null;
  verifier: VerifierDescriptor & { downloadPath: string; conformancePath: string };
  grant: NonNullable<VerificationPackageInput["grant"]> | null;
  /** Stated in the payload so the bank need not read our documentation. */
  howToVerify: string[];
  /** Honest limits of what this package proves. */
  caveats: string[];
}

export const VERIFIER_ARTIFACT_BASE = "/api/v1/verifier";
export const VERIFIER_DOWNLOAD_PATH = `${VERIFIER_ARTIFACT_BASE}/laygrounded-verify.wasm`;
/** Fallback only — `conformanceFile` on the descriptor names the real one. */
export const VERIFIER_CONFORMANCE_PATH = `${VERIFIER_ARTIFACT_BASE}/conformance.json`;

export function buildVerificationPackage(
  input: VerificationPackageInput,
  now: Date = new Date()
): VerificationPackage {
  const caveats: string[] = [];

  if (!input.publishedFigures) {
    caveats.push(
      "This claim has not been computed yet, so there are no published figures to compare the recomputation against. The verifier will still report what it computes from the facts below."
    );
  }
  if (!input.notarization) {
    caveats.push(
      "This claim has not been notarized, so there is no independent timestamp proving when this state existed. The figures can still be recomputed from the facts below."
    );
  }
  if (input.events.length === 0) {
    caveats.push("No confirmed events are attached; the recomputation cannot produce a figure.");
  }
  caveats.push(
    "Only CONFIRMED events are included. Events pushed by an integration but not yet reviewed are excluded by design and do not affect any figure here."
  );
  if (!input.grant) {
    caveats.push(
      "This copy was exported by the claim owner rather than redeemed against a grant, so it carries no access token, expiry or audit trail of who read it. Its verifiability is unaffected — the recomputation below depends on the facts in this package, not on how you received it."
    );
  }

  // Resolved once and used for BOTH the machine-readable path and the prose
  // instruction. They were separate values and drifted the moment a second rule
  // set existed: the field pointed at v2's suite while the step told the reader
  // to download v1's.
  const conformancePath = input.verifier.conformanceFile
    ? `${VERIFIER_ARTIFACT_BASE}/${input.verifier.conformanceFile}`
    : VERIFIER_CONFORMANCE_PATH;

  return {
    format: "laygrounded.claim-verification",
    formatVersion: "1.1",
    issuedAt: now.toISOString(),
    claim: input.claim,
    bundle: {
      claim: {
        vessel: input.claim.vessel,
        voyageRef: input.claim.voyageRef,
        port: input.claim.port,
      },
      cpTerms: input.cpTerms,
      events: input.events,
      // Spread rather than assigned: an explicit `published: undefined` would
      // still create the key, and the canonical JSON both sides digest treats a
      // present-but-undefined key differently from an absent one.
      ...(input.publishedFigures ? { published: input.publishedFigures } : {}),
    },
    publishedFigures: input.publishedFigures,
    notarization: input.notarization,
    verifier: {
      ...input.verifier,
      downloadPath: VERIFIER_DOWNLOAD_PATH,
      // Points at THIS rule set's suite. A fixed path would send a v2 claim's
      // reader to v1's cases, where the root they computed would match the
      // manifest and attest the wrong engine.
      conformancePath,
    },
    grant: input.grant ?? null,
    howToVerify: [
      `Download the verifier from ${VERIFIER_DOWNLOAD_PATH} and check its SHA-256 against verifier.wasmSha256 in this package.`,
      `Optionally download ${conformancePath} and run the ${input.verifier.conformanceCases} conformance cases; the reported root must equal verifier.conformanceRoot (${input.verifier.conformanceRoot || "unavailable"}). Each engine rule set has its OWN suite and root — running another rule set\u2019s cases proves nothing about this claim.`,
      "Run the verifier against the `bundle` object in this package. It is exactly the input shape verifyClaim() expects.",
      "Read `matchesPublished` in the verdict. `true` means the published figures follow, in full, from the stated facts under the stated charterparty terms. `false` names the disagreeing figures in `discrepancies`. `null` means this claim published nothing to compare.",
      "Nothing in this step contacts LayGrounded. The verification is yours, not ours.",
    ],
    caveats,
  };
}
