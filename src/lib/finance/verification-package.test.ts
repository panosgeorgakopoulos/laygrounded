import { describe, expect, test } from "bun:test";
import { recomputeLaytime } from "@laygrounded/laytime-core/gencon94";
import { verifyClaim } from "@laygrounded/laytime-verify";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";
import {
  buildVerificationPackage,
  type VerificationPackageInput,
} from "@/lib/finance/verification-package";

// This module's output is what a credit committee acts on, so the property that
// matters is end-to-end: take the package exactly as a bank receives it, feed
// `bundle` to the verifier exactly as the instructions say to, and require the
// answer to be "verified".

const EVENTS: SofEventInput[] = [
  { id: "1", occurred_at: "2026-03-01T06:00:00+00:00", event_type: "NOR_TENDERED" },
  { id: "2", occurred_at: "2026-03-01T12:00:00+00:00", event_type: "ALL_FAST" },
  { id: "3", occurred_at: "2026-03-01T14:00:00+00:00", event_type: "COMMENCED_LOADING" },
  { id: "4", occurred_at: "2026-03-04T18:00:00+00:00", event_type: "COMPLETED_LOADING" },
];

const CP_TERMS: CpTerms = {
  laytime_allowed_hours: 48,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 12500,
  despatch_rate: 6250,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
} as CpTerms;

function baseInput(
  overrides: Partial<VerificationPackageInput> = {}
): VerificationPackageInput {
  return {
    claim: {
      id: "claim-1",
      vessel: "MV Test",
      voyageRef: "V-001",
      port: "Rotterdam",
      cargo: "Steel coils",
    },
    cpTerms: CP_TERMS,
    events: EVENTS,
    publishedFigures: recomputeLaytime(EVENTS, CP_TERMS),
    notarization: null,
    verifier: {
      version: "1.0.0",
      tzdataDigest: "deadbeef",
      wasmSha256: "a".repeat(64),
      mjsSha256: "b".repeat(64),
      conformanceCases: 500,
      conformanceRoot: "cafebabe",
    },
    grant: {
      institutionLabel: "Test Bank",
      purpose: "Credit assessment",
      expiresAt: "2026-12-31T00:00:00.000Z",
      accessCount: 1,
    },
    ...overrides,
  };
}

describe("buildVerificationPackage", () => {
  test("a bank following the instructions gets matchesPublished: true", () => {
    const pkg = buildVerificationPackage(baseInput());

    // Exactly step 3 of `howToVerify`: run the verifier against `bundle`.
    const verdict = verifyClaim(pkg.bundle);

    expect(verdict.error).toBeNull();
    expect(verdict.matchesPublished).toBe(true);
  });

  test("an uncomputed claim omits `published` and says so", () => {
    const pkg = buildVerificationPackage(baseInput({ publishedFigures: null }));

    // Absent, not present-and-undefined — the key's presence is what the
    // verifier branches on.
    expect("published" in pkg.bundle).toBe(false);
    expect(pkg.publishedFigures).toBeNull();
    expect(verifyClaim(pkg.bundle).matchesPublished).toBeNull();
    expect(pkg.caveats.some((c) => c.includes("has not been computed"))).toBe(true);
  });

  test("tampering with the published figures is detected by the verifier", () => {
    const published = recomputeLaytime(EVENTS, CP_TERMS);
    published.totals.demurrage_amount += 5000;

    const pkg = buildVerificationPackage(baseInput({ publishedFigures: published }));
    const verdict = verifyClaim(pkg.bundle);

    expect(verdict.matchesPublished).toBe(false);
    expect(verdict.discrepancies).toContainEqual(
      expect.objectContaining({ field: "totals.demurrage_amount" })
    );
  });

  test("an ASBATANKVOY claim verifies with its half-rate key intact", () => {
    const terms = { ...CP_TERMS, cp_form: "ASBATANKVOY" } as CpTerms;
    const published = recomputeLaytime(EVENTS, terms);
    expect(published.totals).toHaveProperty("demurrage_half_rate_hours");

    const pkg = buildVerificationPackage(
      baseInput({ cpTerms: terms, publishedFigures: published })
    );

    expect(verifyClaim(pkg.bundle).matchesPublished).toBe(true);
  });

  test("the format version records that published figures are now whole", () => {
    const pkg = buildVerificationPackage(baseInput());
    expect(pkg.formatVersion).toBe("1.1");
    // The 1.0 subset narrative must not survive anywhere a bank would read it.
    expect(pkg).not.toHaveProperty("comparableFields");
    expect(JSON.stringify(pkg)).not.toContain("five of the engine");
  });

  test("caveats always disclose that only confirmed events are included", () => {
    const pkg = buildVerificationPackage(baseInput());
    expect(pkg.caveats.some((c) => c.includes("Only CONFIRMED events"))).toBe(true);
  });

  test("an unnotarized claim is flagged as such", () => {
    const pkg = buildVerificationPackage(baseInput({ notarization: null }));
    expect(pkg.caveats.some((c) => c.includes("not been notarized"))).toBe(true);
  });

  test("issuedAt is the injected clock, so the package is reproducible", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    expect(buildVerificationPackage(baseInput(), now).issuedAt).toBe(now.toISOString());
  });
});
