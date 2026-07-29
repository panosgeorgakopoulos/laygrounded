// Extraction grounding for the pre-fixture CP analyzer.
//
// The analyzer prices real money off terms a model read out of a pasted
// document. A hallucinated laytime allowance would produce a confident,
// specific, wrong number — the worst possible failure for a tool whose whole
// pitch is that its figures are checkable.
//
// So every extracted term must carry the verbatim excerpt it came from, and
// this module checks that excerpt actually appears in the submitted text. A
// term whose excerpt is not in the document is dropped and reported, never
// silently used. Same discipline as `drafting/grounding.ts`, applied at the
// other end of the pipeline: there we verify what the model WROTE, here we
// verify what it CLAIMS TO HAVE READ.
//
// Pure — no LLM, no I/O — so the safety property is testable without either.

export interface ExtractedTerm<T = unknown> {
  /** Which CpTerms field this populates, e.g. "laytime_allowed_hours". */
  field: string;
  value: T;
  /**
   * The passage the model says it read this from. Must appear in the source
   * document, modulo whitespace and case.
   */
  sourceExcerpt: string;
}

export type RejectionReason =
  | "excerpt_not_found" // the quoted passage is not in the document
  | "excerpt_too_short" // too short to be evidence of anything
  | "excerpt_empty";

export interface GroundedTerm<T = unknown> extends ExtractedTerm<T> {
  /** Character offset of the excerpt in the normalised document. */
  matchIndex: number;
}

export interface RejectedTerm<T = unknown> extends ExtractedTerm<T> {
  reason: RejectionReason;
  message: string;
}

export interface ExtractionGroundingResult<T = unknown> {
  grounded: Array<GroundedTerm<T>>;
  rejected: Array<RejectedTerm<T>>;
  /** True when nothing was rejected. */
  verified: boolean;
}

/**
 * Shortest excerpt accepted as evidence.
 *
 * A two-character excerpt like "72" appears in almost any document by chance,
 * so accepting it would make grounding theatre rather than a check. Twelve
 * characters is long enough to require the model to quote surrounding contract
 * language, which is what actually pins the figure to a clause.
 */
export const MIN_EXCERPT_CHARS = 12;

/**
 * Collapses whitespace and lowercases.
 *
 * Pasted charter parties arrive with hard line wraps, tabs and non-breaking
 * spaces from PDF and email clients, so an exact substring test fails on text
 * that is genuinely present. Normalising both sides is what makes the check
 * strict about CONTENT while forgiving about layout — the opposite trade would
 * reject honest extractions and teach users to ignore the warnings.
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/ /g, " ") // non-breaking space
    .replace(/[‘’]/g, "'") // smart single quotes
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Verifies each extracted term against the document it was read from.
 *
 * Note this checks PROVENANCE, not correctness: it proves the model was looking
 * at real text, not that it interpreted that text properly. Interpretation is
 * the risk layer's problem, and the excerpt is carried through so a human can
 * judge it.
 */
export function verifyExtraction<T>(
  documentText: string,
  terms: Array<ExtractedTerm<T>>
): ExtractionGroundingResult<T> {
  const haystack = normalizeForMatch(documentText);
  const grounded: Array<GroundedTerm<T>> = [];
  const rejected: Array<RejectedTerm<T>> = [];

  for (const term of terms) {
    const excerpt = term.sourceExcerpt ?? "";
    const needle = normalizeForMatch(excerpt);

    if (needle.length === 0) {
      rejected.push({
        ...term,
        reason: "excerpt_empty",
        message: `${term.field}: no source passage was quoted, so the value cannot be traced to the document.`,
      });
      continue;
    }
    if (needle.length < MIN_EXCERPT_CHARS) {
      rejected.push({
        ...term,
        reason: "excerpt_too_short",
        message: `${term.field}: quoted passage "${excerpt.trim()}" is too short (needs ${MIN_EXCERPT_CHARS}+ characters) to evidence the value.`,
      });
      continue;
    }

    const matchIndex = haystack.indexOf(needle);
    if (matchIndex === -1) {
      rejected.push({
        ...term,
        reason: "excerpt_not_found",
        message: `${term.field}: quoted passage "${excerpt.trim()}" does not appear in the submitted document.`,
      });
      continue;
    }

    grounded.push({ ...term, matchIndex });
  }

  return { grounded, rejected, verified: rejected.length === 0 };
}
