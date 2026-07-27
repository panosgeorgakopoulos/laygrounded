import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  digestHex,
  runCase,
  runConformance,
  verifyClaim,
  type ConformanceCase,
} from "./verify";
import type { CpTerms, SofEventInput } from "@laygrounded/laytime-core/types";

const CASES_DIR = join(import.meta.dir, "../../../synthetic-corpus/cases");

function loadCorpus(): ConformanceCase[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(CASES_DIR, f), "utf8"));
      return { id: c.id, cpTerms: c.cpTerms, events: c.events, expected: c.expected };
    });
}

const TERMS: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 48,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "UTC",
};

const EVENTS: SofEventInput[] = [
  { id: "nor", occurred_at: "2026-03-02T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "fast", occurred_at: "2026-03-02T14:00:00Z", event_type: "ALL_FAST" },
  { id: "s", occurred_at: "2026-03-02T16:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "e", occurred_at: "2026-03-06T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

describe("canonicalJson", () => {
  test("key order does not change the output", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test("nested objects are sorted too", () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  test("undefined is dropped, null is kept", () => {
    // The distinction matters: an absent optional total and an explicit null
    // are different assertions about the claim.
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  test("array order IS significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("digestHex", () => {
  test("is stable and differs on any change", () => {
    expect(digestHex("abc")).toBe(digestHex("abc"));
    expect(digestHex("abc")).not.toBe(digestHex("abd"));
    expect(digestHex("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("verifyClaim", () => {
  test("published figures that follow from the facts verify", () => {
    const first = verifyClaim({ cpTerms: TERMS, events: EVENTS });
    const verdict = verifyClaim({
      cpTerms: TERMS,
      events: EVENTS,
      published: first.recomputed!,
    });
    expect(verdict.matchesPublished).toBe(true);
    expect(verdict.discrepancies).toBeUndefined();
  });

  test("a doctored total is caught and named", () => {
    const first = verifyClaim({ cpTerms: TERMS, events: EVENTS });
    const tampered = structuredClone(first.recomputed!);
    tampered.totals.demurrage_amount += 5_000;

    const verdict = verifyClaim({ cpTerms: TERMS, events: EVENTS, published: tampered });
    expect(verdict.matchesPublished).toBe(false);
    // "Does not verify" is not useful to a tribunal without saying which figure.
    const field = verdict.discrepancies!.find((d) => d.field === "totals.demurrage_amount");
    expect(field).toBeDefined();
    expect(field!.published).toBe((first.recomputed!.totals.demurrage_amount as number) + 5_000);
  });

  test("a bundle with no published figures still reports the computation", () => {
    const verdict = verifyClaim({ cpTerms: TERMS, events: EVENTS });
    expect(verdict.matchesPublished).toBeNull();
    expect(verdict.recomputed).not.toBeNull();
  });

  test("an uncomputable bundle reports the error rather than throwing", () => {
    const verdict = verifyClaim({
      cpTerms: TERMS,
      events: EVENTS.filter((e) => e.id !== "nor"),
    });
    expect(verdict.error).toBe("NO_NOR");
    expect(verdict.recomputed).toBeNull();
  });

  test("the verdict carries the tzdata digest it was computed under", () => {
    // Without this an arbitrator cannot tell WHICH timezone table produced the
    // answer, which is the whole reason the table is pinned.
    expect(verifyClaim({ cpTerms: TERMS, events: EVENTS }).tzdataDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("conformance suite", () => {
  const corpus = loadCorpus();

  test("the published corpus passes in full", () => {
    if (corpus.length === 0) return; // corpus not generated in this checkout
    const report = runConformance(corpus);
    if (report.failed > 0) {
      throw new Error(
        `${report.failed} conformance failures: ` +
          JSON.stringify(report.failures.slice(0, 5), null, 2),
      );
    }
    expect(report.passed).toBe(corpus.length);
    expect(report.cases).toBe(500);
  });

  test("the root is stable across runs and independent of input order", () => {
    if (corpus.length === 0) return;
    const forward = runConformance(corpus).root;
    const reversed = runConformance([...corpus].reverse()).root;
    // Cases are sorted by id internally, so a shuffled suite must still produce
    // the published root — otherwise the number could not be quoted.
    expect(reversed).toBe(forward);
  });

  test("a corrupted golden fails the suite but leaves the behavioural root alone", () => {
    if (corpus.length === 0) return;
    const tampered = structuredClone(corpus);
    const target = tampered.find((c) => c.expected.result);
    target!.expected.result!.totals.demurrage_amount += 1;

    const report = runConformance(tampered);
    // Conformance is what moved: the artifact no longer agrees with the goldens.
    expect(report.failed).toBeGreaterThan(0);
    // The root did NOT move, and that is correct — the engine's behaviour is
    // unchanged, only the expectation was doctored. Folding expectations into
    // the root would let two artifacts "agree" by failing identically.
    expect(report.root).toBe(runConformance(corpus).root);
  });

  test("a changed INPUT does move the root", () => {
    if (corpus.length === 0) return;
    const tampered = structuredClone(corpus);
    const target = tampered.find((c) => c.expected.result)!;
    target.cpTerms.demurrage_rate += 1_000;

    // Different inputs mean different computed output, so the fingerprint of
    // what the artifact does must change.
    expect(runConformance(tampered).root).not.toBe(runConformance(corpus).root);
  });

  test("error cases are part of the contract", () => {
    const outcome = runCase({
      id: "no-nor",
      cpTerms: TERMS,
      events: EVENTS.filter((e) => e.id !== "nor"),
      expected: { error: "NO_NOR" },
    });
    expect(outcome.ok).toBe(true);
  });

  test("an error sentinel is matched on its prefix, not its prose", () => {
    // The engine throws "MULTIPLE_NOR: Multiple NOR_TENDERED events found"; the
    // sentinel is the contract and the message may be reworded.
    const outcome = runCase({
      id: "multi-nor",
      cpTerms: TERMS,
      events: [...EVENTS, { id: "nor2", occurred_at: "2026-03-02T07:00:00Z", event_type: "NOR_TENDERED" }],
      expected: { error: "MULTIPLE_NOR" },
    });
    expect(outcome.ok).toBe(true);
  });
});
