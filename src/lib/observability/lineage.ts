// Data-lineage recorder: collects provenance entries while a verification
// pass runs, then persists them in one batch. Wrap every external fetch in
// record() — inputs, the transformation step, a compact human-readable
// summary, and a sha256 over the raw payload so the exact bytes any verdict
// was derived from are attestable later.

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logStructured, newTraceId } from "./log";

export interface LineageEntryInput {
  source: string; // e.g. 'open-meteo-era5', 'open-meteo-geocoding', 'ais-provider'
  sourceRef: string; // dataset/endpoint identity
  step: string; // transformation applied
  inputs: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  output: unknown; // raw payload — hashed, not stored
  // Index into the caller's evidence-check array, resolved to a row id at
  // persist time; omit for steps that feed no single check (e.g. geocoding).
  checkIndex?: number;
}

export function hashOutput(output: unknown): string {
  return createHash("sha256").update(JSON.stringify(output ?? null)).digest("hex");
}

export class LineageRecorder {
  private entries: LineageEntryInput[] = [];

  record(entry: LineageEntryInput): void {
    this.entries.push(entry);
  }

  get count(): number {
    return this.entries.length;
  }

  // Persists the collected trail. Lineage must never take down the primary
  // operation, but it must also never fail silently: on error we emit a
  // structured error log (the gap itself becomes an auditable event).
  async persist(
    supabase: SupabaseClient,
    claimId: string,
    checkIds: Array<string | null> = []
  ): Promise<void> {
    if (this.entries.length === 0) return;
    const rows = this.entries.map((e) => ({
      claim_id: claimId,
      evidence_check_id:
        e.checkIndex !== undefined ? checkIds[e.checkIndex] ?? null : null,
      source: e.source,
      source_ref: e.sourceRef,
      step: e.step,
      inputs: e.inputs,
      output_summary: e.outputSummary,
      output_hash: hashOutput(e.output),
    }));

    const { error } = await supabase.from("data_lineage").insert(rows);
    if (error) {
      logStructured("error", "data-lineage", `lineage persist failed: ${error.message}`, {
        trace_id: newTraceId(),
        claim_id: claimId,
        entries: rows.length,
        user_action_required:
          "Evidence verdicts for this run have no provenance rows — re-run verification once the cause is fixed.",
        retry_strategy: "none — lineage is written once per verification run",
      });
    }
  }
}
