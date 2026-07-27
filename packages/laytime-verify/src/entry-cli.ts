// Entrypoint for Node/Bun and, after bundling, for Javy/WASI.
//
// Reads a JSON document on stdin and writes a JSON verdict on stdout. No
// arguments, no files, no network — the whole contract is one document in, one
// verdict out, so the same build serves `node verify.mjs < bundle.json` and
// `wasmtime verify.wasm < bundle.json`.

import { runConformance, verifyClaim, type ConformanceCase, type ClaimBundle } from "./verify";

export function processDocument(text: string): string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return JSON.stringify({ error: "INPUT_NOT_JSON" });
  }

  // A conformance suite is `{ cases: [...] }`; anything else is a claim bundle.
  // Discriminating on shape keeps the CLI argument-free, which matters when the
  // runtime is wasmtime and passing flags through is awkward.
  const asRecord = input as Record<string, unknown>;
  if (Array.isArray(asRecord?.cases)) {
    return JSON.stringify(runConformance(asRecord.cases as ConformanceCase[]), null, 2);
  }
  return JSON.stringify(verifyClaim(input as ClaimBundle), null, 2);
}
