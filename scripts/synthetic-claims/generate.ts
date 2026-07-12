/// <reference types="bun-types" />
// Synthetic claim corpus generator.
//
//   bun scripts/synthetic-claims/generate.ts [--count 500] [--seed 20260712]
//                                            [--out synthetic-corpus] [--no-pdf]
//
// Emits, per case: a ground-truth JSON (events + CP terms + the blessed
// engine result) and a realistic SoF PDF. A case is only emitted when
//   (1) the engine's output passes every engine-independent invariant,
//   (2) the archetype's feature assertion proves the edge case manifested,
//   (3) a second engine run reproduces the result bit-for-bit.
// The corpus is deterministic in (seed, count): regenerating with the same
// arguments yields byte-identical case JSONs.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { recomputeLaytime } from "../../src/lib/laytime/gencon94";
import { computeTimeBar } from "../../src/lib/time-bar";
import { SofEventInput } from "../../src/lib/laytime/types";
import { ARCHETYPES, Scenario } from "./scenarios";
import { checkInvariants } from "./invariants";
import { renderSofPdf } from "./pdf";
import { Rng } from "./rng";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// --- CLI args ---
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const COUNT = parseInt(argValue("--count") ?? "500", 10);
const SEED = parseInt(argValue("--seed") ?? "20260712", 10);
const OUT = path.resolve(REPO_ROOT, argValue("--out") ?? "synthetic-corpus");
const WITH_PDF = !process.argv.includes("--no-pdf");
const MAX_ATTEMPTS = 40;

// FNV-1a — stable per-archetype seed salt.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function engineInputs(scenario: Scenario): SofEventInput[] {
  return scenario.events.map((e) => ({
    id: e.id,
    occurred_at: e.occurred_at,
    event_type: e.event_type,
  }));
}

interface EmittedCase {
  id: string;
  archetype: string;
  seed: number;
  description: string;
  claim: Scenario["claim"];
  cpTerms: Scenario["cpTerms"];
  events: Scenario["events"];
  expected:
    | { result: ReturnType<typeof recomputeLaytime>; error?: undefined }
    | { error: string; result?: undefined };
  timeBar?: {
    asOf: string;
    timeBarDays: number;
    expected: { state: string; deadline: string | null; daysRemaining: number | null };
  };
}

function buildCase(
  archetypeName: string,
  build: (rng: Rng) => Scenario,
  caseSeed: number,
  id: string
): { emitted: EmittedCase; attempts: number } {
  let lastReason = "no attempt run";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = new Rng(caseSeed).child(attempt);
    const scenario = build(rng);
    const inputs = engineInputs(scenario);

    // --- Error archetypes: the engine must refuse, with the right message ---
    if (scenario.expectError) {
      try {
        recomputeLaytime(inputs, scenario.cpTerms);
        lastReason = "expected engine error but computation succeeded";
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!new RegExp(scenario.expectError).test(msg)) {
          lastReason = `wrong error: ${msg}`;
          continue;
        }
        return {
          emitted: {
            id,
            archetype: scenario.archetype,
            seed: caseSeed,
            description: scenario.description,
            claim: scenario.claim,
            cpTerms: scenario.cpTerms,
            events: scenario.events,
            expected: { error: scenario.expectError },
          },
          attempts: attempt + 1,
        };
      }
    }

    // --- Normal archetypes ---
    let result;
    try {
      result = recomputeLaytime(inputs, scenario.cpTerms);
    } catch (e) {
      lastReason = `engine rejected scenario: ${e instanceof Error ? e.message : e}`;
      continue;
    }

    // Determinism: identical inputs must reproduce identical output.
    const again = recomputeLaytime(inputs, scenario.cpTerms);
    if (JSON.stringify(again) !== JSON.stringify(result)) {
      throw new Error(`ENGINE NON-DETERMINISM detected in ${archetypeName} (seed ${caseSeed})`);
    }

    // Invariants are laws — a violation is an engine bug, not a bad draw.
    const violations = checkInvariants(inputs, scenario.cpTerms, result);
    if (violations.length > 0) {
      throw new Error(
        `INVARIANT VIOLATION in ${archetypeName} (seed ${caseSeed}, attempt ${attempt}):\n  ` +
          violations.join("\n  ") +
          `\n  events: ${JSON.stringify(inputs)}\n  cpTerms: ${JSON.stringify(scenario.cpTerms)}`
      );
    }

    if (scenario.feature && !scenario.feature(result)) {
      lastReason = "feature assertion not satisfied (edge case did not manifest)";
      continue;
    }

    // Time-bar cases: pin the countdown to the frozen asOf.
    let timeBar: EmittedCase["timeBar"];
    if (scenario.timeBar) {
      const tb = computeTimeBar({
        timeBarDays: scenario.timeBar.timeBarDays,
        events: inputs.map((e) => ({ event_type: e.event_type, occurred_at: e.occurred_at })),
        hasSofDocument: true,
        hasValidCpTerms: true,
        hasCalculation: true,
        now: new Date(scenario.timeBar.asOf),
      });
      if (tb.state !== scenario.timeBar.intendedState) {
        lastReason = `time-bar landed in "${tb.state}", intended "${scenario.timeBar.intendedState}"`;
        continue;
      }
      timeBar = {
        asOf: scenario.timeBar.asOf,
        timeBarDays: scenario.timeBar.timeBarDays,
        expected: { state: tb.state, deadline: tb.deadline, daysRemaining: tb.daysRemaining },
      };
    }

    return {
      emitted: {
        id,
        archetype: scenario.archetype,
        seed: caseSeed,
        description: scenario.description,
        claim: scenario.claim,
        cpTerms: scenario.cpTerms,
        events: scenario.events,
        expected: { result },
        ...(timeBar ? { timeBar } : {}),
      },
      attempts: attempt + 1,
    };
  }

  throw new Error(
    `Archetype ${archetypeName} produced no valid case in ${MAX_ATTEMPTS} attempts ` +
      `(seed ${caseSeed}). Last reason: ${lastReason}`
  );
}

async function main() {
  const t0 = performance.now();

  // Per-archetype allocation proportional to weight; remainder to the
  // largest fractional parts so totals hit COUNT exactly.
  const totalWeight = ARCHETYPES.reduce((a, x) => a + x.weight, 0);
  const raw = ARCHETYPES.map((a) => (COUNT * a.weight) / totalWeight);
  const alloc = raw.map(Math.floor);
  let remainder = COUNT - alloc.reduce((a, x) => a + x, 0);
  const byFraction = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % byFraction.length, remainder--) {
    alloc[byFraction[k].i]++;
  }

  const casesDir = path.join(OUT, "cases");
  const sofsDir = path.join(OUT, "sofs");
  fs.rmSync(casesDir, { recursive: true, force: true });
  fs.rmSync(sofsDir, { recursive: true, force: true });
  fs.mkdirSync(casesDir, { recursive: true });
  if (WITH_PDF) fs.mkdirSync(sofsDir, { recursive: true });

  const summary: Array<{ archetype: string; cases: number; attempts: number }> = [];
  let emittedTotal = 0;

  for (const [ai, arch] of ARCHETYPES.entries()) {
    let attempts = 0;
    for (let i = 0; i < alloc[ai]; i++) {
      const caseSeed = (SEED ^ fnv1a(arch.name) ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
      const id = `${arch.name}-${String(i + 1).padStart(4, "0")}`;
      const { emitted, attempts: a } = buildCase(arch.name, arch.build, caseSeed, id);
      attempts += a;

      fs.writeFileSync(
        path.join(casesDir, `${id}.json`),
        JSON.stringify(emitted, null, 2) + "\n"
      );
      if (WITH_PDF) {
        const pdfScenario: Scenario = {
          archetype: emitted.archetype,
          description: emitted.description,
          claim: emitted.claim,
          cpTerms: emitted.cpTerms,
          events: emitted.events,
        };
        fs.writeFileSync(path.join(sofsDir, `${id}.pdf`), await renderSofPdf(pdfScenario));
      }
      emittedTotal++;
    }
    summary.push({ archetype: arch.name, cases: alloc[ai], attempts });
  }

  const engineSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/laytime/gencon94.ts"),
    "utf8"
  );
  const manifest = {
    generator: "synthetic-claims v1",
    seed: SEED,
    count: emittedTotal,
    withPdfs: WITH_PDF,
    engineSha256: createHash("sha256").update(engineSource).digest("hex"),
    byArchetype: Object.fromEntries(summary.map((s) => [s.archetype, s.cases])),
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const ms = Math.round(performance.now() - t0);
  console.log(`\nSynthetic claim corpus — seed ${SEED}\n`);
  for (const s of summary) {
    const retries = s.attempts - s.cases;
    console.log(
      `  ${s.archetype.padEnd(32)} ${String(s.cases).padStart(4)} cases` +
        (retries > 0 ? `  (${retries} retries)` : "")
    );
  }
  console.log(
    `\n  TOTAL ${emittedTotal} cases${WITH_PDF ? " + PDFs" : ""} → ${path.relative(REPO_ROOT, OUT)}/  [${ms}ms]`
  );
  console.log(`  engine sha256: ${manifest.engineSha256.slice(0, 16)}…\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
