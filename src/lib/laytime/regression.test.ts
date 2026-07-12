/// <reference types="bun-types" />
// Synthetic-corpus regression suite.
//
// Replays every case in synthetic-corpus/cases/ against the current engine
// and fails on ANY divergence from the blessed golden result — plus re-checks
// the engine-independent invariants and the frozen time-bar expectations.
//
//   Generate/refresh the corpus:  bun scripts/synthetic-claims/generate.ts
//   Run just this suite:          bun test src/lib/laytime/regression.test.ts
//
// A red test here means engine behavior changed. If the change is intentional,
// regenerate the corpus (same seed) and review the golden diff; if not, you
// just caught a regression in seconds.

import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { recomputeLaytime } from "./gencon94";
import { computeTimeBar, TimeBarState } from "../time-bar";
import { CpTerms, SofEventInput } from "./types";
import { checkInvariants } from "../../../scripts/synthetic-claims/invariants";

const CASES_DIR = path.resolve(import.meta.dir, "../../../synthetic-corpus/cases");

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

if (!fs.existsSync(CASES_DIR)) {
  describe("synthetic corpus regression", () => {
    it.skip("corpus not generated — run: bun scripts/synthetic-claims/generate.ts", () => {});
  });
} else {
  const files = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  describe(`synthetic corpus regression (${files.length} cases)`, () => {
    for (const file of files) {
      const c: CorpusCase = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8"));
      it(c.id, () => {
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
