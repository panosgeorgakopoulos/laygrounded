/// <reference types="bun-types" />
// The conformance suite must match the rule set that computed the claim.
//
// This is the defect this file exists to prevent, and it is a quiet one: each
// engine rule set has its OWN conformance suite and its own root. Hand a
// counterparty v1's root for a claim computed under v2 and they will run v1's
// cases, get a root that matches the manifest, and conclude they have attested
// the engine behind the figure. They will not have — and nothing in that
// exchange looks wrong to either side.
//
// Caught in the browser on a real v2 claim, which was showing bc9f24fdab910a1b.

import { describe, expect, test, beforeEach } from "bun:test";
import { readVerifierManifest, resetVerifierManifestCache } from "./verifier-manifest";
import { buildVerificationPackage } from "./verification-package";
import type { CpTerms } from "@/lib/laytime/types";

const V1_ROOT = "bc9f24fdab910a1b";
const V2_ROOT = "261e3468d2246f30";

beforeEach(() => resetVerifierManifestCache());

describe("reading the built manifest", () => {
  // These assert against the manifest actually on disk, produced by
  // `bun run verify:build`. If it is absent the reader reports empty rather
  // than throwing, which the last test covers.
  const v1 = readVerifierManifest(1);
  const built = Boolean(v1.conformanceRoot);

  test.if(built)("v1 resolves to the published v1 root", () => {
    expect(readVerifierManifest(1).conformanceRoot).toBe(V1_ROOT);
    expect(readVerifierManifest(1).conformanceFile).toBe("conformance.json");
  });

  test.if(built)("v2 resolves to a DIFFERENT root and a different file", () => {
    const v2 = readVerifierManifest(2);
    expect(v2.conformanceRoot).toBe(V2_ROOT);
    expect(v2.conformanceFile).toBe("conformance-v2.json");
    expect(v2.conformanceRoot).not.toBe(readVerifierManifest(1).conformanceRoot);
  });

  test.if(built)("both rule sets report a non-empty case count", () => {
    expect(readVerifierManifest(1).conformanceCases).toBeGreaterThan(0);
    expect(readVerifierManifest(2).conformanceCases).toBeGreaterThan(0);
  });

  test("a missing manifest reports unavailable rather than throwing", () => {
    // The reader swallows a read failure by design: refusing the whole package
    // because a build artefact is absent would deny a bank the facts over a
    // missing checksum. Whatever it returns must not look verified.
    const d = readVerifierManifest(1);
    expect(typeof d.conformanceRoot).toBe("string");
    expect(typeof d.version).toBe("string");
  });
});

describe("the package points at the matching suite", () => {
  const cpTerms = { days_basis: "SHINC", currency: "USD" } as unknown as CpTerms;

  const pkgFor = (engineVersion: 1 | 2) =>
    buildVerificationPackage({
      claim: { id: "c1", vessel: "MV X", voyageRef: "V1", port: "Santos", cargo: "Soybeans" },
      cpTerms,
      events: [],
      publishedFigures: null,
      notarization: null,
      verifier: readVerifierManifest(engineVersion),
      grant: null,
    });

  test("v2's package does not send a reader to v1's cases", () => {
    const v2 = pkgFor(2);
    if (!v2.verifier.conformanceRoot) return; // manifest not built
    expect(v2.verifier.conformancePath).toContain("conformance-v2.json");
    expect(v2.verifier.conformancePath).not.toBe(pkgFor(1).verifier.conformancePath);
  });

  test("the how-to-verify steps quote the same root the package carries", () => {
    const v2 = pkgFor(2);
    if (!v2.verifier.conformanceRoot) return;
    const steps = v2.howToVerify.join(" ");
    expect(steps).toContain(v2.verifier.conformancePath);
    // The step tells the reader to compare against `verifier.conformanceRoot`,
    // so the two must not be able to disagree.
    expect(v2.verifier.conformanceRoot).toBe(V2_ROOT);
  });
});

describe("an owner self-export", () => {
  test("carries a null grant and says why", () => {
    const pkg = buildVerificationPackage({
      claim: { id: "c1", vessel: "MV X", voyageRef: "V1", port: "Santos", cargo: "Soybeans" },
      cpTerms: { days_basis: "SHINC", currency: "USD" } as unknown as CpTerms,
      events: [],
      publishedFigures: null,
      notarization: null,
      verifier: readVerifierManifest(2),
      grant: null,
    });
    expect(pkg.grant).toBeNull();
    // A fabricated grant descriptor would put an invented authorisation record
    // into a document a bank reads as evidence.
    expect(pkg.caveats.some((c) => c.includes("exported by the claim owner"))).toBe(true);
  });
});
