// Legal prosecution & forensic notary.
//
// Two consolidated capabilities:
//   * Immutable time-proof snapshots — a SHA-256 Merkle tree over every
//     timeline event, every hour of the calculation breakdown, and the CP
//     clause configuration in force. The root is the claim's verifiable
//     digital fingerprint: stored on compliance_ledger.cryptographic_signature,
//     re-derivable by any auditor from the disclosed leaves, with per-leaf
//     membership proofs for arbitration ("this exact WEATHER_DELAY event was
//     part of the record notarized on date X").
//   * Arrest / freezing-injunction pre-filing — evaluates an unpaid claim's
//     enforcement posture, surfaces asset leads (subject vessel, sister-ship
//     candidates from the tenant's own book), and assembles a template
//     dossier of the filings admiralty counsel would need. Deterministic and
//     template-based by design: no AI, no legal conclusions. Every dossier is
//     HITL-gated (pending_human_reviews) and carries an explicit
//     counsel-review disclaimer — this module prepares, it never files.
//
// Pure module: crypto hashing only, no I/O, no Supabase, deterministic for
// identical inputs (timestamps are inputs, never Date.now()).

import { createHash } from "crypto";
import type { BreakdownRow, CalculationTotals, CpTerms } from "@/lib/laytime/types";

// === Canonical hashing ===

// Key-sorted, whitespace-free JSON so semantically identical objects hash
// identically regardless of construction order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// === Merkle tree ===

// Levels bottom-up: levels[0] = leaf hashes, last level = [root]. Odd nodes
// are promoted unchanged (no duplication — simpler proofs, still collision
// resistant because every leaf is domain-prefixed by its kind).
export function buildMerkleLevels(leafHashes: string[]): string[][] {
  if (leafHashes.length === 0) throw new Error("EMPTY_LEDGER");
  const levels: string[][] = [leafHashes];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? sha256Hex(prev[i] + prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }
  return levels;
}

export interface MerkleProofStep {
  sibling: string;
  position: "left" | "right";
}

export function merkleProof(leafHashes: string[], leafIndex: number): MerkleProofStep[] {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) throw new Error("LEAF_OUT_OF_RANGE");
  const levels = buildMerkleLevels(leafHashes);
  const proof: MerkleProofStep[] = [];
  let idx = leafIndex;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIdx < level.length) {
      proof.push({
        sibling: level[siblingIdx],
        position: siblingIdx < idx ? "left" : "right",
      });
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  expectedRoot: string
): boolean {
  let hash = leafHash;
  for (const step of proof) {
    hash = step.position === "left" ? sha256Hex(step.sibling + hash) : sha256Hex(hash + step.sibling);
  }
  return hash === expectedRoot;
}

// === Time-proof snapshots ===

export const SNAPSHOT_ALGO = "sha256-merkle-v1";

export interface SnapshotLedger {
  cpTerms: CpTerms;
  totals: CalculationTotals;
  breakdown: BreakdownRow[]; // the hour-by-hour matrix
  events: Array<{ id: string; event_type: string; occurred_at: string }>;
  clauseFlags?: Array<{ clause_ref: string; severity: string; note: string }>;
  // Notarization instant — an input, so the snapshot is reproducible.
  asOf: string;
}

export interface SnapshotLeaf {
  index: number;
  kind: "header" | "cp_terms" | "totals" | "event" | "breakdown_row" | "clause_flag";
  ref: string; // human pointer: event id, row index, clause ref…
  hash: string;
}

export interface TimeProofSnapshot {
  claimId: string;
  algo: typeof SNAPSHOT_ALGO;
  asOf: string;
  merkleRoot: string;
  leafCount: number;
  leaves: SnapshotLeaf[];
}

// Domain-prefixed leaf material: two leaves of different kinds can never
// collide even if their JSON bodies coincide.
function leafMaterial(kind: SnapshotLeaf["kind"], ref: string, body: unknown): string {
  return `${kind}|${ref}|${canonicalJson(body)}`;
}

export function generateCryptographicSnapshot(
  claimId: string,
  ledger: SnapshotLedger
): TimeProofSnapshot {
  const specs: Array<{ kind: SnapshotLeaf["kind"]; ref: string; body: unknown }> = [
    { kind: "header", ref: claimId, body: { claim_id: claimId, as_of: ledger.asOf, algo: SNAPSHOT_ALGO } },
    { kind: "cp_terms", ref: "cp_terms", body: ledger.cpTerms },
    { kind: "totals", ref: "totals", body: ledger.totals },
    ...ledger.events.map((e) => ({ kind: "event" as const, ref: e.id, body: e })),
    ...ledger.breakdown.map((row, i) => ({
      kind: "breakdown_row" as const,
      ref: `row-${i}`,
      body: row,
    })),
    ...(ledger.clauseFlags ?? []).map((f, i) => ({
      kind: "clause_flag" as const,
      ref: `${f.clause_ref}#${i}`,
      body: f,
    })),
  ];

  const leaves: SnapshotLeaf[] = specs.map((s, index) => ({
    index,
    kind: s.kind,
    ref: s.ref,
    hash: sha256Hex(leafMaterial(s.kind, s.ref, s.body)),
  }));

  const levels = buildMerkleLevels(leaves.map((l) => l.hash));
  return {
    claimId,
    algo: SNAPSHOT_ALGO,
    asOf: ledger.asOf,
    merkleRoot: levels[levels.length - 1][0],
    leafCount: leaves.length,
    leaves,
  };
}

// True iff the ledger as supplied still hashes to the notarized root — the
// auditor's one-call tamper check.
export function verifySnapshot(
  claimId: string,
  ledger: SnapshotLedger,
  expectedRoot: string
): boolean {
  return generateCryptographicSnapshot(claimId, ledger).merkleRoot === expectedRoot;
}

// Audit-ready dossier: the fingerprint, the method, the leaf inventory, and
// mechanical re-verification instructions. Markdown, ready for the drafts
// pane or a PDF export.
export function buildAuditDossier(
  snapshot: TimeProofSnapshot,
  meta: { vessel: string; voyageRef: string; port: string }
): string {
  const grouped = snapshot.merkleRoot.replace(/(.{8})/g, "$1 ").trim();
  const leafRows = snapshot.leaves
    .map((l) => `| ${l.index} | ${l.kind} | ${l.ref} | \`${l.hash.slice(0, 16)}…\` |`)
    .join("\n");
  return `# Time-Proof Snapshot — ${meta.vessel} / ${meta.voyageRef} (${meta.port})

**Digital fingerprint (SHA-256 Merkle root)**

\`\`\`
${grouped}
\`\`\`

- Algorithm: \`${snapshot.algo}\`
- Notarized (as-of): ${snapshot.asOf}
- Claim: ${snapshot.claimId}
- Leaves: ${snapshot.leafCount} (CP clause configuration, calculation totals, ${snapshot.leaves.filter((l) => l.kind === "event").length} timeline events, ${snapshot.leaves.filter((l) => l.kind === "breakdown_row").length} hour-by-hour breakdown rows)

## What this proves

Every leaf below is the SHA-256 hash of the domain-prefixed, key-sorted JSON
of one element of the claim record at the notarization instant. The Merkle
root commits to all of them at once: altering any timestamp, clause term, or
computed hour after the fact changes the root. Any party holding the
disclosed record can recompute the root independently and compare.

## Leaf inventory

| # | Kind | Reference | Leaf hash (truncated) |
|---|------|-----------|-----------------------|
${leafRows}

## Verification procedure

1. Canonicalize each disclosed element as key-sorted JSON.
2. Hash \`kind|ref|json\` with SHA-256 to reproduce each leaf.
3. Pair leaves left-to-right, hashing concatenated hex; promote odd nodes.
4. The surviving hash must equal the fingerprint above.

*Generated by LayGrounded's deterministic notary (no AI involvement). This
snapshot is evidence of record integrity, not a legal opinion.*`;
}

// === Arrest / freezing-injunction pre-filing ===

export const ARREST_DISCLAIMER =
  "PRE-FILING WORK PRODUCT — NOT LEGAL ADVICE AND NOT A COURT FILING. Every statement, asset lead and draft below must be independently verified, completed and signed by admiralty counsel admitted in the arrest forum before any application is made. Wrongful arrest exposes the applicant to damages and counter-security.";

// Days a quantified demand may reasonably go unpaid before escalation to
// security measures is normally considered.
export const DEFAULT_UNPAID_GRACE_DAYS = 90;

export interface ArrestClaimFacts {
  id: string;
  vessel: string;
  vesselImo: string | null;
  port: string;
  counterpartyName: string | null;
  currency: string;
  demurrageAmount: number | null;
  settledAt: string | null;
  // Latest confirmed completion event (time-bar anchor); null = no anchor.
  completionAt: string | null;
  timeBarDays: number;
  // When the demand letter was served, if known; falls back to completion.
  demandServedAt?: string | null;
}

export interface RelatedClaimFacts {
  vessel: string;
  vesselImo: string | null;
  counterpartyName: string | null;
  status: string;
}

export interface AssetLead {
  type: "subject_vessel" | "sister_ship_lead";
  vessel: string;
  vesselImo: string | null;
  basis: string;
}

export interface ChecklistItem {
  key: string;
  label: string;
  authority: string;
}

export interface ArrestPreFilingAssessment {
  eligible: boolean;
  blockers: string[]; // empty when eligible
  cautions: string[]; // weaknesses counsel must weigh, non-blocking
  unpaidDays: number | null;
  claimAmount: number;
  currency: string;
  candidateAssets: AssetLead[];
  jurisdictionChecklist: ChecklistItem[];
  badFaithIndicators: string[]; // data-derived observations for counsel, never conclusions
  draftParticulars: string; // markdown skeleton with [COUNSEL: …] placeholders
  humanReviewRequired: true;
  disclaimer: string;
}

export interface ArrestPreFilingInput {
  claim: ArrestClaimFacts;
  relatedClaims: RelatedClaimFacts[];
  contradictedEvidenceCount: number;
  asOf: string;
  unpaidGraceDays?: number;
}

const MS_PER_DAY = 24 * 3600_000;

const JURISDICTION_CHECKLIST: ChecklistItem[] = [
  {
    key: "maritime_claim",
    label:
      "Confirm demurrage under the charterparty qualifies as a 'maritime claim' in the arrest forum",
    authority: "Arrest Convention 1952 Art. 1(1)(d)–(e); Arrest Convention 1999 Art. 1(1)(f)",
  },
  {
    key: "forum_convention_status",
    label:
      "Confirm the intended forum is party to the 1952 or 1999 Convention (or has equivalent domestic admiralty jurisdiction)",
    authority: "Forum ratification status — counsel to verify",
  },
  {
    key: "ownership_at_arrest",
    label:
      "Verify the target ship's registered ownership at the time of arrest via the forum's ship registry",
    authority: "Arrest Convention 1952 Art. 3(1); 1999 Art. 3(1)",
  },
  {
    key: "sister_ship_link",
    label:
      "For any sister-ship arrest, prove common beneficial ownership when the claim arose — registry extracts, not commercial inference",
    authority: "Arrest Convention 1952 Art. 3(1); 1999 Art. 3(2)",
  },
  {
    key: "counter_security",
    label: "Budget for counter-security / wrongful-arrest exposure required by the forum",
    authority: "Arrest Convention 1999 Art. 6; forum procedural rules",
  },
  {
    key: "freezing_alternative",
    label:
      "Assess a freezing injunction over other assets as the alternative where ship arrest is impractical",
    authority: "Forum interim-relief rules (e.g. worldwide freezing order practice) — counsel to advise",
  },
];

function buildDraftParticulars(
  claim: ArrestClaimFacts,
  amount: number,
  unpaidDays: number | null,
  assets: AssetLead[],
  badFaith: string[]
): string {
  const respondent = claim.counterpartyName ?? "[COUNSEL: identify respondent]";
  const assetLines = assets
    .map(
      (a) =>
        `- ${a.vessel}${a.vesselImo ? ` (IMO ${a.vesselImo})` : ""} — ${a.type === "subject_vessel" ? "subject vessel" : "sister-ship lead"}; basis: ${a.basis}${a.type === "sister_ship_lead" ? " [COUNSEL: verify common ownership via registry extract]" : ""}`
    )
    .join("\n");
  const badFaithLines = badFaith.length
    ? badFaith.map((b) => `- ${b} [COUNSEL: assess whether this supports a bad-faith averment]`).join("\n")
    : "- None derived from the record.";

  return `# DRAFT — Particulars of Claim in Support of Arrest Application

**Claimant:** [COUNSEL: full legal name of owner/operator]
**Respondent:** ${respondent}
**Subject vessel:** ${claim.vessel}${claim.vesselImo ? ` (IMO ${claim.vesselImo})` : ""}
**Port of claim:** ${claim.port}

## 1. The claim

1. The Claimant claims ${claim.currency} ${amount.toLocaleString("en-US")} in demurrage arising
   under the governing charterparty, computed by a deterministic laytime engine from the
   confirmed Statement of Facts record and notarized by cryptographic snapshot
   [COUNSEL: exhibit the time-proof dossier].
2. Demand was made and the sum has remained unpaid${unpaidDays !== null ? ` for ${unpaidDays} days` : ""} as at [DATE].
3. The claim is a maritime claim within Art. 1(1)(d)–(e) of the 1952 Arrest Convention
   (Art. 1(1)(f) of the 1999 Convention) [COUNSEL: adapt to forum].

## 2. Assets identified for arrest / attachment

${assetLines}

## 3. Observations relevant to urgency and conduct

${badFaithLines}

## 4. Relief sought

- Warrant of arrest over the subject vessel, alternatively a sister ship in common
  ownership [COUNSEL: confirm per registry]; alternatively
- A freezing injunction over the Respondent's assets in the jurisdiction to the value
  of the claim plus interest and costs.

## 5. Undertakings

[COUNSEL: forum-required undertakings, counter-security and full-and-frank disclosure.]

---
${ARREST_DISCLAIMER}`;
}

// Evaluates enforcement posture and assembles the counsel dossier. Pure:
// all facts (including "now") arrive as inputs; nothing is filed, sent, or
// concluded here.
export function prepareArrestPreFiling(input: ArrestPreFilingInput): ArrestPreFilingAssessment {
  const { claim } = input;
  const graceDays = input.unpaidGraceDays ?? DEFAULT_UNPAID_GRACE_DAYS;
  const now = new Date(input.asOf).getTime();
  if (isNaN(now)) throw new Error("INVALID_AS_OF");

  const amount = claim.demurrageAmount ?? 0;
  const anchor = claim.demandServedAt ?? claim.completionAt;
  const unpaidDays =
    anchor != null ? Math.floor((now - new Date(anchor).getTime()) / MS_PER_DAY) : null;

  const blockers: string[] = [];
  const cautions: string[] = [];

  if (amount <= 0) blockers.push("No positive demurrage quantum on the latest calculation.");
  if (claim.settledAt != null) blockers.push("Claim is already settled — nothing to secure.");
  if (unpaidDays === null) {
    blockers.push(
      "No completion or demand date on record — the unpaid period cannot be established."
    );
  } else if (unpaidDays < graceDays) {
    blockers.push(
      `Only ${unpaidDays} day(s) unpaid — below the ${graceDays}-day escalation threshold.`
    );
  }

  if (claim.completionAt != null) {
    const barDeadline = new Date(claim.completionAt).getTime() + claim.timeBarDays * MS_PER_DAY;
    if (now > barDeadline && claim.demandServedAt == null) {
      cautions.push(
        `The ${claim.timeBarDays}-day presentation window has lapsed with no recorded demand — counsel must confirm the claim was presented in time or the bar was interrupted before any arrest is sought.`
      );
    }
  }
  if (input.contradictedEvidenceCount > 0) {
    cautions.push(
      `${input.contradictedEvidenceCount} of the claim's own delay events were contradicted by independent evidence — expect them to be attacked; consider excluding them from the secured quantum.`
    );
  }

  // Asset leads: the subject vessel, then distinct same-counterparty vessels
  // from the tenant's own book. Leads only — common ownership is proven by
  // registry extract, never inferred here.
  const candidateAssets: AssetLead[] = [
    {
      type: "subject_vessel",
      vessel: claim.vessel,
      vesselImo: claim.vesselImo,
      basis: "Vessel in respect of which the claim arose (Art. 3(1)).",
    },
  ];
  const seen = new Set([claim.vesselImo ?? claim.vessel]);
  if (claim.counterpartyName) {
    for (const rc of input.relatedClaims) {
      const key = rc.vesselImo ?? rc.vessel;
      if (seen.has(key)) continue;
      if (rc.counterpartyName?.trim().toLowerCase() !== claim.counterpartyName.trim().toLowerCase())
        continue;
      seen.add(key);
      candidateAssets.push({
        type: "sister_ship_lead",
        vessel: rc.vessel,
        vesselImo: rc.vesselImo,
        basis: `Same counterparty (${claim.counterpartyName}) on another claim in the claimant's book — ownership link unverified.`,
      });
    }
  }

  const badFaithIndicators: string[] = [];
  if (unpaidDays !== null && unpaidDays >= graceDays && claim.demandServedAt != null) {
    badFaithIndicators.push(
      `Quantified demand served ${unpaidDays} day(s) ago and ignored without substantive response on record.`
    );
  }

  const eligible = blockers.length === 0;
  return {
    eligible,
    blockers,
    cautions,
    unpaidDays,
    claimAmount: amount,
    currency: claim.currency,
    candidateAssets,
    jurisdictionChecklist: JURISDICTION_CHECKLIST,
    badFaithIndicators,
    draftParticulars: buildDraftParticulars(claim, amount, unpaidDays, candidateAssets, badFaithIndicators),
    humanReviewRequired: true,
    disclaimer: ARREST_DISCLAIMER,
  };
}
