// Precedent import pipeline for the Legal Knowledge Graph (kb_precedents).
//
// Case law is NEVER fabricated. kb_precedents ships EMPTY; this ingests a JSON
// file of precedents the operator has sourced from a LICENSED provider. Every
// row MUST carry a source_label, so nothing enters the public knowledge base
// unattributed.
//
//   bun scripts/seed/kb-import.ts <precedents.json>
//
// The JSON is an array of:
//   { caseName, citation?, jurisdiction?, decidedOn?, summary, holding?, tags?, sourceLabel, sourceUrl? }

import fs from "node:fs";
import { createServiceRoleClient } from "@/lib/supabase/server";

interface RawPrecedent {
  caseName: string;
  citation?: string;
  jurisdiction?: string;
  decidedOn?: string;
  summary: string;
  holding?: string;
  tags?: string[];
  sourceLabel: string;
  sourceUrl?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun scripts/seed/kb-import.ts <precedents.json>");
    console.error(
      "kb_precedents ships empty by design — provide a licensed JSON to populate it. Case law is never fabricated."
    );
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array of precedents.");

  const rows = (parsed as RawPrecedent[]).map((p, i) => {
    if (!p.caseName || !p.summary || !p.sourceLabel) {
      throw new Error(
        `Row ${i}: caseName, summary and sourceLabel are all required — every precedent must be attributed to its source.`
      );
    }
    return {
      slug: slugify(`${p.caseName}-${p.citation ?? i}`),
      case_name: p.caseName,
      citation: p.citation ?? null,
      jurisdiction: p.jurisdiction ?? null,
      decided_on: p.decidedOn ?? null,
      summary: p.summary,
      holding: p.holding ?? null,
      tags: p.tags ?? [],
      source_label: p.sourceLabel,
      source_url: p.sourceUrl ?? null,
    };
  });

  const db = createServiceRoleClient();
  const { error } = await db.from("kb_precedents").upsert(rows, { onConflict: "slug" });
  if (error) throw new Error(`kb_precedents upsert failed: ${error.message}`);
  console.log(`Imported ${rows.length} precedent(s) into kb_precedents.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
