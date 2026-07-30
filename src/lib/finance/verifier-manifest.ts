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
  conformance?: { cases?: number; root?: string };
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

/** Cached: the file cannot change without a redeploy. */
let cached: VerifierDescriptor | null = null;

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
export function readVerifierManifest(): VerifierDescriptor {
  if (cached) return cached;

  let raw: RawManifest = {};
  try {
    raw = JSON.parse(readFileSync(VERIFIER_MANIFEST_PATH, "utf8")) as RawManifest;
  } catch {
    raw = {};
  }

  cached = {
    version: raw.verifierVersion ?? "unavailable",
    tzdataDigest: raw.tzdataDigest ?? "",
    wasmSha256: raw.artifacts?.wasm?.sha256 ?? "",
    mjsSha256: raw.artifacts?.mjs?.sha256 ?? "",
    conformanceCases: raw.conformance?.cases ?? 0,
    conformanceRoot: raw.conformance?.root ?? "",
  };
  return cached;
}

/** Test seam: forget the cached manifest. */
export function resetVerifierManifestCache(): void {
  cached = null;
}
