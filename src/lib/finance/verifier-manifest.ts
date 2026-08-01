// Reads the offline verifier's build manifest.
//
// The manifest is produced by `bun run verify:build` alongside the .wasm and
// .mjs artefacts, and records their digests plus the conformance root. It is
// the fingerprint a bank checks the downloaded verifier against — so it is read
// from the package on disk rather than restated here, where it would drift the
// first time the verifier is rebuilt and nobody notices.

import { readFileSync } from "fs";
import { join } from "path";
import type { VerifierDescriptor } from "./verification-package";

interface RawManifest {
  verifierVersion?: string;
  tzdataDigest?: string;
  /** The v1 suite, under the unqualified key it has always had. */
  conformance?: { cases?: number; root?: string };
  /** One entry per engine rule set. Added when the engine gained a second one. */
  conformanceSuites?: Array<{
    engineVersion?: number;
    file?: string;
    cases?: number;
    root?: string;
  }>;
  artifacts?: {
    wasm?: { sha256?: string };
    mjs?: { sha256?: string };
  };
}

/**
 * Where the manifest lives relative to the running server.
 *
 * The standalone build copies the workspace in, so the package path resolves
 * the same in dev and in the Docker image.
 */
export const VERIFIER_MANIFEST_PATH = join(
  process.cwd(),
  "packages",
  "laytime-verify",
  "dist",
  "manifest.json"
);

/** Cached per rule set: the file cannot change without a redeploy. */
const cached = new Map<number, VerifierDescriptor>();

/**
 * The verifier fingerprint, or an explicitly-unavailable one.
 *
 * A missing manifest returns empty digests rather than throwing. The
 * verification package is still useful without them — the bank can recompute
 * from the bundle either way — and refusing the whole package because a build
 * artefact is absent would deny a bank the facts over a missing checksum. The
 * empty strings are visible in the response, so nobody mistakes an unavailable
 * fingerprint for a verified one.
 */
export function readVerifierManifest(engineVersion: 1 | 2 = 1): VerifierDescriptor {
  const hit = cached.get(engineVersion);
  if (hit) return hit;

  let raw: RawManifest = {};
  try {
    raw = JSON.parse(readFileSync(VERIFIER_MANIFEST_PATH, "utf8")) as RawManifest;
  } catch {
    raw = {};
  }

  // THE SUITE MUST MATCH THE RULE SET THAT COMPUTED THE CLAIM.
  //
  // Each rule set has its own conformance suite and its own root. Handing a
  // counterparty v1's root for a claim computed under v2 would send them to run
  // the wrong suite, get a root that matches the manifest, and conclude they had
  // attested the engine behind the figure. They would not have. The whole point
  // of publishing a root is that it identifies ONE engine.
  const suite = raw.conformanceSuites?.find((x) => x.engineVersion === engineVersion);

  // v1 falls back to the unqualified key, which predates `conformanceSuites`
  // and is the same value. v2 has no such fallback: an older manifest genuinely
  // does not describe it, and reporting empty is honest where reporting v1's
  // numbers would be a lie.
  const legacy = engineVersion === 1 ? raw.conformance : undefined;

  const descriptor: VerifierDescriptor = {
    version: raw.verifierVersion ?? "unavailable",
    tzdataDigest: raw.tzdataDigest ?? "",
    wasmSha256: raw.artifacts?.wasm?.sha256 ?? "",
    mjsSha256: raw.artifacts?.mjs?.sha256 ?? "",
    conformanceCases: suite?.cases ?? legacy?.cases ?? 0,
    conformanceRoot: suite?.root ?? legacy?.root ?? "",
    conformanceFile: suite?.file ?? (legacy ? "conformance.json" : ""),
  };
  cached.set(engineVersion, descriptor);
  return descriptor;
}

/** Test seam: forget the cached manifest. */
export function resetVerifierManifestCache(): void {
  cached.clear();
}
