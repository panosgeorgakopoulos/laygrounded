// @laygrounded/laytime-core — public API barrel.
//
// The deterministic heart of LayGrounded, extracted as an open-source (Apache-2.0)
// package: the GENCON 94 / ASBATANKVOY laytime engine, scenario diffing and
// dispute-sensitivity analysis. Pure TypeScript — no I/O, no AI, no database —
// which is exactly what makes it independently testable and reusable.

export * from "./types";
export * from "./gencon94";
export * from "./diff";
export * from "./sensitivity";
// Timezone resolution from a pinned offset table — exported because callers that
// need a port-local date (holiday matching, SoF observation) must use the SAME
// resolution the engine does. Two implementations would eventually disagree
// about which local day an event fell on.
export * from "./tz";
// Behavioural provenance: exported so a notarized derivation record and the
// offline verifier fingerprint the engine the same way.
export * from "./fingerprint";
