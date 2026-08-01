/// <reference types="bun-types" />
// Synthetic-corpus regression suite.
//
// Replays every case in synthetic-corpus/cases/ against the current engine
// and fails on ANY divergence from the blessed golden result — plus re-checks
// the engine-independent invariants and the frozen time-bar expectations.
//
//   Generate/refresh the corpus:  bun scripts/synthetic-claims/generate.ts
//                                 bun scripts/synthetic-claims/generate.ts \
//                                     --engine-version 2 --no-pdf
//   Run just this suite:          bun test src/lib/laytime/regression.test.ts
//
// A red test here means engine behavior changed. If the change is intentional,
// regenerate the corpus (same seed) and review the golden diff; if not, you
// just caught a regression in seconds.
//
// TWO CORPORA, one per rule set. Each case carries its own `engine_version` in
// `cpTerms`, so both suites run through the same call — the version is an input
// to the engine, not a mode the test has to set up. The v1 corpus is FROZEN: its
// 500 cases carry the published conformance root `bc9f24fdab910a1b`, and a claim
// already served or notarised under those rules has to keep reproducing the
// figures on the document.

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { recomputeLaytime } from "./gencon94";
import { computeTimeBar, TimeBarState } from "../time-bar";
import { CpTerms, SofEventInput } from "./types";
import { checkInvariants } from "../../../scripts/synthetic-claims/invariants";

const CORPORA = [
  { label: "v1", dir: path.resolve(import.meta.dir, "../../../synthetic-corpus/cases") },
  { label: "v2", dir: path.resolve(import.meta.dir, "../../../synthetic-corpus-v2/cases") },
];

interface CorpusCase {
  id: string;
  archetype: string;
  description: string;
  cpTerms: CpTerms;
  events: Array<SofEventInput & { verbatim: string }>;
  expected: { result?: ReturnType<typeof recomputeLaytime>; error?: string };
  timeBar?: {
    asOf: string;
    timeBarDays: number;
    expected: { state: TimeBarState; deadline: string | null; daysRemaining: number | null };
  };
}

for (const corpus of CORPORA) {
  if (!fs.existsSync(corpus.dir)) {
    describe(`synthetic corpus regression (${corpus.label})`, () => {
      it.skip("corpus not generated — run: bun scripts/synthetic-claims/generate.ts", () => {});
    });
    continue;
  }

  const files = fs
    .readdirSync(corpus.dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  describe(`synthetic corpus regression ${corpus.label} (${files.length} cases)`, () => {
    for (const file of files) {
      const c: CorpusCase = JSON.parse(fs.readFileSync(path.join(corpus.dir, file), "utf8"));
      it(`${corpus.label}/${c.id}`, () => {
        const inputs: SofEventInput[] = c.events.map((e) => ({
          id: e.id,
          occurred_at: e.occurred_at,
          event_type: e.event_type,
        }));

        if (c.expected.error) {
          expect(() => recomputeLaytime(inputs, c.cpTerms)).toThrow(
            new RegExp(c.expected.error)
          );
        } else {
          const result = recomputeLaytime(inputs, c.cpTerms);
          expect(result).toEqual(c.expected.result!);
          expect(checkInvariants(inputs, c.cpTerms, result)).toEqual([]);
        }

        if (c.timeBar) {
          const tb = computeTimeBar({
            timeBarDays: c.timeBar.timeBarDays,
            events: inputs.map((e) => ({
              event_type: e.event_type,
              occurred_at: e.occurred_at,
            })),
            hasSofDocument: true,
            hasValidCpTerms: true,
            hasCalculation: true,
            now: new Date(c.timeBar.asOf),
          });
          expect({
            state: tb.state,
            deadline: tb.deadline,
            daysRemaining: tb.daysRemaining,
          }).toEqual(c.timeBar.expected);
        }
      });
    }
  });
}
