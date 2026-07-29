import { describe, expect, test } from "bun:test";
import {
  verifyExtraction,
  normalizeForMatch,
  MIN_EXCERPT_CHARS,
  type ExtractedTerm,
} from "./grounding";

const DOC = `
CHARTER PARTY RECAP
MV OCEAN HARMONY / Voyage V24-101
Laytime: 72 running hours SHINC, weather permitting.
Demurrage USD 24,000 per day pro rata.
Turn time: six (6) hours after valid NOR tendered.
`;

function term(over: Partial<ExtractedTerm> = {}): ExtractedTerm {
  return {
    field: "laytime_allowed_hours",
    value: 72,
    sourceExcerpt: "Laytime: 72 running hours SHINC",
    ...over,
  };
}

describe("normalizeForMatch", () => {
  const cases: Array<{ name: string; a: string; b: string }> = [
    { name: "collapses runs of whitespace", a: "Laytime:   72    hours", b: "Laytime: 72 hours" },
    { name: "ignores hard line wraps", a: "Laytime: 72\nrunning hours", b: "Laytime: 72 running hours" },
    { name: "ignores tabs", a: "Laytime:\t72 hours", b: "Laytime: 72 hours" },
    { name: "ignores case", a: "LAYTIME: 72 HOURS", b: "laytime: 72 hours" },
    { name: "normalises non-breaking spaces", a: "Laytime: 72 hours", b: "Laytime: 72 hours" },
    { name: "normalises smart quotes", a: "the “vessel’s” laytime", b: 'the "vessel\'s" laytime' },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(normalizeForMatch(c.a)).toBe(normalizeForMatch(c.b));
    });
  }

  test("does not collapse genuinely different content", () => {
    expect(normalizeForMatch("72 hours")).not.toBe(normalizeForMatch("27 hours"));
  });
});

describe("verifyExtraction — accepts real provenance", () => {
  test("an excerpt present in the document is grounded", () => {
    const r = verifyExtraction(DOC, [term()]);
    expect(r.verified).toBe(true);
    expect(r.grounded).toHaveLength(1);
    expect(r.grounded[0].matchIndex).toBeGreaterThanOrEqual(0);
  });

  test("layout differences do not cause a false rejection", () => {
    // The model re-flows the passage it quotes; the content is identical.
    const r = verifyExtraction(DOC, [
      term({ sourceExcerpt: "  Laytime:  72   running\n  hours  SHINC  " }),
    ]);
    expect(r.verified).toBe(true);
  });

  test("case differences do not cause a false rejection", () => {
    const r = verifyExtraction(DOC, [term({ sourceExcerpt: "LAYTIME: 72 RUNNING HOURS SHINC" })]);
    expect(r.verified).toBe(true);
  });

  test("several honest terms all pass", () => {
    const r = verifyExtraction(DOC, [
      term(),
      term({ field: "demurrage_rate", value: 24000, sourceExcerpt: "Demurrage USD 24,000 per day" }),
      term({ field: "turn_time_hours", value: 6, sourceExcerpt: "Turn time: six (6) hours" }),
    ]);
    expect(r.verified).toBe(true);
    expect(r.grounded).toHaveLength(3);
  });
});

describe("verifyExtraction — rejects fabrication", () => {
  test("an excerpt absent from the document is rejected", () => {
    const r = verifyExtraction(DOC, [
      term({ value: 48, sourceExcerpt: "Laytime: 48 running hours SHEX" }),
    ]);
    expect(r.verified).toBe(false);
    expect(r.rejected[0].reason).toBe("excerpt_not_found");
    expect(r.rejected[0].message).toContain("does not appear");
  });

  test("a plausible-but-invented figure is caught even though the wording is contractual", () => {
    // The trap this layer exists for: fluent, well-formed, entirely fabricated.
    const r = verifyExtraction(DOC, [
      term({
        field: "demurrage_rate",
        value: 45000,
        sourceExcerpt: "Demurrage USD 45,000 per day pro rata",
      }),
    ]);
    expect(r.verified).toBe(false);
    expect(r.grounded).toHaveLength(0);
  });

  test("an empty excerpt is rejected — a value with no provenance is not evidence", () => {
    const r = verifyExtraction(DOC, [term({ sourceExcerpt: "" })]);
    expect(r.rejected[0].reason).toBe("excerpt_empty");
  });

  test("a whitespace-only excerpt is rejected", () => {
    const r = verifyExtraction(DOC, [term({ sourceExcerpt: "   \n  " })]);
    expect(r.rejected[0].reason).toBe("excerpt_empty");
  });

  test("a too-short excerpt is rejected even when it does appear", () => {
    // "72" is in the document, but matching on it would make grounding theatre.
    expect(DOC).toContain("72");
    const r = verifyExtraction(DOC, [term({ sourceExcerpt: "72" })]);
    expect(r.rejected[0].reason).toBe("excerpt_too_short");
    expect(r.rejected[0].message).toContain(String(MIN_EXCERPT_CHARS));
  });

  test("good and bad terms are separated, not failed as a batch", () => {
    const r = verifyExtraction(DOC, [
      term(),
      term({ field: "demurrage_rate", value: 99, sourceExcerpt: "Demurrage USD 99,000 per day" }),
    ]);
    expect(r.verified).toBe(false);
    expect(r.grounded).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.grounded[0].field).toBe("laytime_allowed_hours");
  });
});

describe("verifyExtraction — edge cases", () => {
  test("no terms verifies vacuously", () => {
    const r = verifyExtraction(DOC, []);
    expect(r.verified).toBe(true);
    expect(r.grounded).toEqual([]);
  });

  test("an empty document rejects everything rather than throwing", () => {
    const r = verifyExtraction("", [term()]);
    expect(r.verified).toBe(false);
    expect(r.rejected[0].reason).toBe("excerpt_not_found");
  });

  test("the value is carried through untouched for the caller to use", () => {
    const r = verifyExtraction(DOC, [term({ value: 72 })]);
    expect(r.grounded[0].value).toBe(72);
    expect(r.grounded[0].sourceExcerpt).toBe("Laytime: 72 running hours SHINC");
  });
});
