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

import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

/** Fingerprint of the verifier the bank should run. Straight from its manifest. */
export interface VerifierDescriptor {
  version: string;
  tzdataDigest: string;
  wasmSha256: string;
  mjsSha256: string;
  conformanceCases: number;
  conformanceRoot: string;
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
 * The figures as persisted for this claim.
 *
 * DELIBERATELY NOT a `LaytimeResult`. `laytime_calculations` stores five of the
 * engine's seven totals — `time_on_demurrage_hours` and `time_saved_hours` are
 * not persisted — so a full result cannot be reconstructed faithfully from the
 * database. Presenting a partial object as though it were complete is worse
 * than presenting less: the verifier compares whole results, so the missing
 * fields would make a perfectly good claim report "does not verify", which is
 * precisely the wrong answer to hand a credit committee.
 *
 * So the package ships what was actually stored, names which fields are
 * comparable, and tells the bank to compare those.
 */
export interface PublishedFigures {
  allowedHours: number;
  usedHours: number;
  demurrageAmount: number;
  despatchAmount: number;
  currency: string;
  /** Engine breakdown rows exactly as persisted. */
  breakdown: unknown[];
}

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
  grant: {
    institutionLabel: string;
    purpose: string;
    expiresAt: string;
    accessCount: number;
  };
}

/** Totals a bank should compare, mapping our field name to the engine's. */
export const COMPARABLE_FIELDS: Array<{ published: string; recomputed: string }> = [
  { published: "publishedFigures.allowedHours", recomputed: "totals.allowed_hours" },
  { published: "publishedFigures.usedHours", recomputed: "totals.used_hours" },
  { published: "publishedFigures.demurrageAmount", recomputed: "totals.demurrage_amount" },
  { published: "publishedFigures.despatchAmount", recomputed: "totals.despatch_amount" },
];

export interface VerificationPackage {
  format: "laygrounded.claim-verification";
  formatVersion: "1.0";
  issuedAt: string;
  claim: VerificationPackageInput["claim"];
  /**
   * Exactly the shape `verifyClaim()` in @laygrounded/laytime-verify consumes.
   *
   * `published` is omitted on purpose — see `PublishedFigures`. The verifier
   * therefore returns `matchesPublished: null` and simply reports what it
   * computes from the facts; the comparison is done against `publishedFigures`
   * on the named fields.
   */
  bundle: {
    claim: { vessel: string; voyageRef: string; port: string };
    cpTerms: CpTerms;
    events: SofEventInput[];
  };
  publishedFigures: PublishedFigures | null;
  /** Which figures to compare, and against what. */
  comparableFields: typeof COMPARABLE_FIELDS;
  notarization: NotarizationDescriptor | null;
  verifier: VerifierDescriptor & { downloadPath: string; conformancePath: string };
  grant: VerificationPackageInput["grant"];
  /** Stated in the payload so the bank need not read our documentation. */
  howToVerify: string[];
  /** Honest limits of what this package proves. */
  caveats: string[];
}

export const VERIFIER_DOWNLOAD_PATH = "/api/v1/verifier/laygrounded-verify.wasm";
export const VERIFIER_CONFORMANCE_PATH = "/api/v1/verifier/conformance.json";

export function buildVerificationPackage(
  input: VerificationPackageInput,
  now: Date = new Date()
): VerificationPackage {
  const caveats: string[] = [];

  if (!input.publishedFigures) {
    caveats.push(
      "This claim has not been computed yet, so there are no published figures to compare the recomputation against. The verifier will still report what it computes from the facts below."
    );
  } else {
    caveats.push(
      "LayGrounded persists five of the engine's seven totals, so this package publishes those five rather than a whole result object. Compare the fields named in comparableFields; the verifier's own output is complete."
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

  return {
    format: "laygrounded.claim-verification",
    formatVersion: "1.0",
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
    },
    publishedFigures: input.publishedFigures,
    comparableFields: COMPARABLE_FIELDS,
    notarization: input.notarization,
    verifier: {
      ...input.verifier,
      downloadPath: VERIFIER_DOWNLOAD_PATH,
      conformancePath: VERIFIER_CONFORMANCE_PATH,
    },
    grant: input.grant,
    howToVerify: [
      `Download the verifier from ${VERIFIER_DOWNLOAD_PATH} and check its SHA-256 against verifier.wasmSha256 in this package.`,
      `Optionally download ${VERIFIER_CONFORMANCE_PATH} and run the ${input.verifier.conformanceCases} conformance cases; the reported root must equal verifier.conformanceRoot.`,
      "Run the verifier against the `bundle` object in this package. It is exactly the input shape verifyClaim() expects.",
      "Compare the verifier's `recomputed.totals` against `publishedFigures`, field by field, using the mapping in `comparableFields`. Equality on those fields means the published figures follow from the stated facts under the stated charterparty terms.",
      "Nothing in this step contacts LayGrounded. The verification is yours, not ours.",
    ],
    caveats,
  };
}
