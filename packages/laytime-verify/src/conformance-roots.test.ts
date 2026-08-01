/// <reference types="bun-types" />
// The published conformance roots, pinned.
//
// A root is the number a third party checks BEFORE trusting the verifier on
// their own claim: run the published suite, compare the root, and the artifact's
// agreement on your 501st case means something. It is therefore not an
// implementation detail that may drift with a refactor — it is published, it
// appears in the verifier README, and RFC-3161 tokens are anchored over
// documents that cite it.
//
// `bc9f24fdab910a1b` is the ONE value in this repository that a change may never
// move. If this file goes red, the question is never "what is the new root" — it
// is "what did I just change about rule set 1", because the answer must be
// "nothing".

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { recomputeLaytime } from "@laygrounded/laytime-core/gencon94";
import type { CpTerms } from "@laygrounded/laytime-core/types";
import { canonicalJson, runConformance, type ConformanceCase } from "./verify";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** The root published in README.md and in every v1 manifest. Frozen. */
const V1_ROOT = "bc9f24fdab910a1b";
/** Engine v2's root. New, and free to be new — nothing was ever published under it. */
const V2_ROOT = "261e3468d2246f30";

interface CorpusCase extends ConformanceCase {
  archetype: string;
  cpTerms: CpTerms & { engine_version?: 1 | 2 };
}

function load(dir: string): CorpusCase[] {
  const full = path.join(REPO_ROOT, dir, "cases");
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(full, f), "utf8")));
}

const v1 = load("synthetic-corpus");
const v2 = load("synthetic-corpus-v2");

describe("conformance roots", () => {
  it("v1 reproduces the published root over 500 cases", () => {
    expect(v1.length).toBe(500);
    const report = runConformance(v1);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(500);
    expect(report.root).toBe(V1_ROOT);
  });

  it("v2 reproduces its own root over 500 cases", () => {
    expect(v2.length).toBe(500);
    const report = runConformance(v2);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(500);
    expect(report.root).toBe(V2_ROOT);
  });

  it("the two roots differ — a shared root would mean the fix never landed", () => {
    expect(V2_ROOT).not.toBe(V1_ROOT);
  });

  it("v1 cases carry no engine_version, which is what makes them v1", () => {
    // Absence is the v1 marker. Writing `engine_version: 1` into these files
    // would change all 500 of them and with them the published root.
    expect(v1.filter((c) => "engine_version" in c.cpTerms)).toEqual([]);
  });

  it("every v2 case is explicitly stamped", () => {
    expect(v2.filter((c) => c.cpTerms.engine_version !== 2)).toEqual([]);
  });
});

describe("what v2 actually changed", () => {
  const replay = (c: CorpusCase, terms: CpTerms) => {
    try {
      return canonicalJson(recomputeLaytime(c.events, terms));
    } catch (e) {
      return `error:${e instanceof Error ? e.message : String(e)}`;
    }
  };

  it("changes nothing on any of the 500 cases published under v1", () => {
    // The v1 corpus never exercises the defect: `exceptedPeriod` pins SHEX
    // precisely because SHINC could not express the correct answer. So every
    // published case must compute identically under both rule sets — v2 is a
    // strict no-op on the entire legacy suite.
    const diverged = v1.filter(
      (c) => replay(c, c.cpTerms) !== replay(c, { ...c.cpTerms, engine_version: 2 })
    );
    expect(diverged.map((c) => c.id)).toEqual([]);
  });

  it("changes ONLY the SHINC agreed-exception cases in the v2 corpus", () => {
    const diverged = v2.filter((c) => {
      const { engine_version: _v, ...asV1 } = c.cpTerms;
      return replay(c, asV1 as CpTerms) !== replay(c, c.cpTerms);
    });

    // 456 shared cases identical, 44 in the two archetypes v1 could not express.
    expect(diverged.length).toBe(44);
    expect([...new Set(diverged.map((c) => c.archetype))].sort()).toEqual([
      "shinc-excepted-over-sunday",
      "shinc-excepted-period",
    ]);
    expect(v2.length - diverged.length).toBe(456);
  });

  it("deducts the agreed exception in every such case — and in none of them under v1", () => {
    const subjects = v2.filter((c) => c.archetype.startsWith("shinc-excepted"));
    expect(subjects.length).toBe(44);

    const deducts = (terms: CpTerms, c: CorpusCase) =>
      recomputeLaytime(c.events, terms).breakdown.some(
        (b) => !b.counts && b.clause_ref === "GENCON94-7(c)"
      );

    for (const c of subjects) {
      const { engine_version: _v, ...asV1 } = c.cpTerms;
      expect({ id: c.id, v1: deducts(asV1 as CpTerms, c), v2: deducts(c.cpTerms, c) }).toEqual({
        id: c.id,
        v1: false,
        v2: true,
      });
    }
  });

  it("never increases used hours — the fix can only ever deduct", () => {
    for (const c of v2) {
      if (c.expected.error) continue;
      const { engine_version: _v, ...asV1 } = c.cpTerms;
      const before = recomputeLaytime(c.events, asV1 as CpTerms).totals.used_hours;
      const after = recomputeLaytime(c.events, c.cpTerms).totals.used_hours;
      expect(after).toBeLessThanOrEqual(before);
    }
  });
});
