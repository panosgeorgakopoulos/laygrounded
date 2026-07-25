// Re-export shim → the open-source core package (@laygrounded/laytime-core).
// Scenario diffing now lives in packages/laytime-core; this keeps the app's
// established `@/lib/laytime/diff` import path working unchanged.
export * from "@laygrounded/laytime-core/diff";
