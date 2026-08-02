// The claim's ledger: how this number came to be.
//
// A READ-TIME PROJECTION, NOT A NEW TABLE. The obvious design — a
// `claim_audit_logs` table written on every change — is worse than it looks:
//
//   * it would need backfilling, which means INVENTING timestamps for
//     everything that happened before it existed;
//   * it would be a second copy of facts that already carry their own times
//     (`sof_events.created_at`, `laytime_calculations.computed_at`,
//     `compliance_ledger.recorded_at`), free to drift from them;
//   * a writer that failed would leave a hole nobody could detect, because
//     there would be nothing to compare the ledger against.
//
// Projecting at read time cannot disagree with the record, because it IS the
// record. The cost is a fan-out of small queries per claim, which is bounded
// and paid only when someone opens the tab.
//
// The one thing this module will not do is guess. An entry whose actor cannot
// be established from the data is reported as `unknown`, never attributed to a
// person — an audit trail that invents an actor is worse than none, because it
// will be believed.

/** Who caused the entry. The distinction the audit tab exists to make. */
export type ActorKind =
  /** A person, acting through the app. */
  | "human"
  /** An automated internal process: engine recompute, cron sweep, trigger. */
  | "system"
  /** A model or an autonomous agent. */
  | "ai"
  /** An external system: an ERP push, an inbound webhook, a counterparty. */
  | "external"
  /** Genuinely not recorded. Never a guess. */
  | "unknown";

export type ActivityCategory =
  | "claim"
  | "timeline"
  | "calculation"
  | "evidence"
  | "negotiation"
  | "settlement"
  | "legal"
  | "integration"
  | "document";

export interface ActivityEntry {
  /** Stable within a response; used only as a React key. */
  id: string;
  at: string;
  category: ActivityCategory;
  actorKind: ActorKind;
  /** Display name where one is recorded. Null is honest, not missing. */
  actorLabel: string | null;
  /** One line, past tense, specific. */
  summary: string;
  /** Optional second line: the detail somebody auditing would want. */
  detail?: string | null;
  /** Money the entry moved or asserted, when it moved any. */
  amount?: { value: number; currency: string } | null;
}

// === Source row shapes (only the columns this module reads) ===

export interface SofEventRow {
  id: string;
  event_type: string;
  occurred_at: string;
  created_at: string | null;
  source: string | null;
  status: string;
}

export interface ProposalRow {
  id: string;
  action: string;
  status: string;
  note: string | null;
  proposed_by_label: string | null;
  share_id: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface CalculationRow {
  computed_at: string | null;
  used_hours: number | null;
  demurrage_amount: number | null;
  despatch_amount: number | null;
  currency: string | null;
}

export interface EvidenceRow {
  id: string;
  check_type: string;
  verdict: string;
  summary: string | null;
  checked_at: string | null;
}

export interface LineageRow {
  id: string;
  source: string;
  source_ref: string | null;
  step: string;
  recorded_at: string | null;
}

export interface DomainEventRow {
  id: string | number;
  event_type: string;
  occurred_at: string;
}

export interface NotarizationRow {
  id: string;
  entry_kind: string;
  cryptographic_signature: string | null;
  recorded_at: string | null;
}

export interface NegotiationRoomRow {
  id: string;
  agent_rounds_completed: number | null;
  final_settlement_probability: number | null;
  settlement_matrix: Record<string, unknown> | null;
  created_at: string;
}

export interface SettlementPayloadRow {
  id: string;
  settlement_ref: string;
  ready: boolean;
  created_at: string;
}

export interface DraftRow {
  id: string;
  kind: string;
  model: string | null;
  created_at: string;
}

export interface ClaimRow {
  created_at: string | null;
  agreed_at: string | null;
  negotiation_opened_at: string | null;
  settled_at: string | null;
  settled_amount: number | null;
  engine_version: number | null;
  external_source: string | null;
}

export interface ActivitySources {
  claim: ClaimRow;
  currency: string;
  events: SofEventRow[];
  proposals: ProposalRow[];
  calculation: CalculationRow | null;
  evidence: EvidenceRow[];
  lineage: LineageRow[];
  domainEvents: DomainEventRow[];
  notarizations: NotarizationRow[];
  negotiations: NegotiationRoomRow[];
  settlements: SettlementPayloadRow[];
  drafts: DraftRow[];
}

/**
 * How an event got onto the timeline, mapped to who is answerable for it.
 *
 * `sof_events.source` is the only provenance the row carries. `manual` is a
 * person; `ai` and `multimodal` are extraction; `erp` and `chain` came from
 * another system. Anything unrecognised reports `unknown` rather than
 * defaulting to a human — attributing a machine's action to a person is the
 * failure mode that makes an audit trail actively misleading.
 */
export function actorForEventSource(source: string | null): ActorKind {
  switch (source) {
    case "manual":
      return "human";
    case "ai":
    case "multimodal":
      return "ai";
    case "erp":
    case "chain":
    case "telemetry":
      return "external";
    default:
      return "unknown";
  }
}

const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase();

/**
 * Merges every source into one chronological ledger, newest first.
 *
 * Pure: the caller loads the rows. Entries with no usable timestamp are
 * DROPPED rather than dated `now` — an undated fact placed at the top of a
 * ledger would read as the most recent thing that happened.
 */
export function buildClaimActivity(sources: ActivitySources): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const ccy = sources.currency;

  // Entries with no usable timestamp are DROPPED rather than dated `now` — an
  // undated fact placed at the top of a ledger reads as the most recent thing
  // that happened.
  const add = (e: (Omit<ActivityEntry, "at"> & { at: string | null }) | null) => {
    if (e && e.at && !Number.isNaN(Date.parse(e.at))) out.push(e as ActivityEntry);
  };

  // --- The claim itself ---
  add(
    sources.claim.created_at
      ? {
          id: "claim-created",
          at: sources.claim.created_at,
          category: "claim",
          actorKind: sources.claim.external_source ? "external" : "human",
          actorLabel: sources.claim.external_source ?? null,
          summary: sources.claim.external_source
            ? `Claim created from ${sources.claim.external_source}`
            : "Claim created",
        }
      : null
  );

  add(
    sources.claim.negotiation_opened_at
      ? {
          id: "negotiation-opened",
          at: sources.claim.negotiation_opened_at,
          category: "negotiation",
          actorKind: "human",
          actorLabel: null,
          summary: "Counterparty negotiation opened",
        }
      : null
  );

  add(
    sources.claim.agreed_at
      ? {
          id: "claim-agreed",
          at: sources.claim.agreed_at,
          category: "settlement",
          actorKind: "human",
          actorLabel: null,
          summary: "Claim agreed — figures final",
          detail: "Settlement instruction unlocked; the calculation is pinned from this moment.",
        }
      : null
  );

  add(
    sources.claim.settled_at
      ? {
          id: "claim-settled",
          at: sources.claim.settled_at,
          category: "settlement",
          actorKind: "human",
          actorLabel: null,
          summary: "Settlement recorded",
          amount:
            sources.claim.settled_amount != null
              ? { value: sources.claim.settled_amount, currency: ccy }
              : null,
        }
      : null
  );

  // --- Timeline events ---
  for (const e of sources.events) {
    // `created_at` is when it landed on the claim; `occurred_at` is when it
    // happened at the port. The ledger is about the former — this is a record
    // of what the SYSTEM did, not of the voyage.
    add({
      id: `event-${e.id}`,
      // `created_at` may be null on legacy rows; `occurred_at` is NOT NULL, so
      // the fallback always yields a string.
      at: e.created_at ?? e.occurred_at,
      category: "timeline",
      actorKind: actorForEventSource(e.source),
      actorLabel: e.source,
      summary: `${titleCase(e.event_type)} added to the timeline`,
      detail: `Occurred ${e.occurred_at.slice(0, 16).replace("T", " ")}Z · status ${e.status}`,
    });
  }

  // --- Proposals: raised and decided are two separate facts ---
  for (const p of sources.proposals) {
    const fromGuest = Boolean(p.share_id);
    add({
      id: `proposal-${p.id}`,
      at: p.created_at,
      category: "negotiation",
      actorKind: fromGuest ? "external" : "human",
      actorLabel: p.proposed_by_label,
      summary: `Dispute raised — ${titleCase(p.action)}`,
      detail: p.note,
    });
    if (p.decided_at) {
      add({
        id: `proposal-decided-${p.id}`,
        at: p.decided_at,
        category: "negotiation",
        actorKind: "human",
        actorLabel: null,
        summary: `Dispute ${p.status}`,
        detail:
          p.status === "accepted"
            ? "The amendment was applied to the timeline and the claim recomputed."
            : null,
      });
    }
  }

  // --- The calculation ---
  if (sources.calculation?.computed_at) {
    const c = sources.calculation;
    const net = (c.demurrage_amount ?? 0) - (c.despatch_amount ?? 0);
    add({
      id: "calculation",
      at: c.computed_at,
      category: "calculation",
      actorKind: "system",
      actorLabel: `laytime engine v${sources.claim.engine_version ?? 1}`,
      summary: `Laytime recomputed — ${c.used_hours ?? 0} hours used`,
      detail: `Rule set ${sources.claim.engine_version ?? 1}. Deterministic: the same events and terms always produce this figure.`,
      amount: { value: net, currency: c.currency ?? ccy },
    });
  }

  // --- Evidence verdicts ---
  for (const v of sources.evidence) {
    add({
      id: `evidence-${v.id}`,
      at: v.checked_at ?? "",
      category: "evidence",
      actorKind: "system",
      actorLabel: v.check_type.startsWith("motion") ? "AIS motion check" : v.check_type,
      summary: `Evidence ${v.verdict} — ${titleCase(v.check_type)}`,
      detail: v.summary,
    });
  }

  // --- External data fetches ---
  for (const l of sources.lineage) {
    add({
      id: `lineage-${l.id}`,
      at: l.recorded_at ?? "",
      category: "evidence",
      actorKind: "external",
      actorLabel: l.source,
      summary: `External data retrieved — ${l.step}`,
      detail: l.source_ref,
    });
  }

  // --- Notarisations ---
  for (const n of sources.notarizations) {
    add({
      id: `notary-${n.id}`,
      at: n.recorded_at ?? "",
      category: "legal",
      actorKind: "system",
      actorLabel: "notary",
      summary: "Claim state sealed",
      detail: n.cryptographic_signature
        ? `Merkle root ${n.cryptographic_signature.slice(0, 24)}… — any change after this breaks the seal.`
        : null,
    });
  }

  // --- Autonomous negotiation runs ---
  for (const r of sources.negotiations) {
    const matrix = (r.settlement_matrix ?? {}) as Record<string, unknown>;
    const recommended = typeof matrix.recommendedSettlement === "number" ? matrix.recommendedSettlement : null;
    add({
      id: `negotiation-${r.id}`,
      at: r.created_at,
      category: "negotiation",
      actorKind: "ai",
      actorLabel: "autonomous negotiator",
      summary:
        recommended != null
          ? `Agents recommended a settlement after ${r.agent_rounds_completed ?? 0} round(s)`
          : "Autonomous negotiation run",
      detail:
        r.final_settlement_probability != null
          ? `Settlement likelihood ${Math.round(r.final_settlement_probability * 100)}%. Queued for human approval — nothing settled automatically.`
          : "Queued for human approval — nothing settled automatically.",
      amount:
        recommended != null
          ? { value: recommended, currency: (matrix.currency as string) ?? ccy }
          : null,
    });
  }

  // --- Settlement instructions ---
  for (const s of sources.settlements) {
    add({
      id: `settlement-${s.id}`,
      at: s.created_at,
      category: "settlement",
      actorKind: "system",
      actorLabel: "settlement worker",
      summary: `Payment instruction generated — ${s.settlement_ref}`,
      detail: s.ready ? "Ready to act on." : "Generated with blockers; not actionable as it stands.",
    });
  }

  // --- Drafts ---
  for (const d of sources.drafts) {
    add({
      id: `draft-${d.id}`,
      at: d.created_at,
      category: "document",
      actorKind: d.model ? "ai" : "human",
      actorLabel: d.model,
      summary: `${titleCase(d.kind)} drafted`,
    });
  }

  // --- Outbox facts ---
  //
  // Deliberately last and deliberately terse. `domain_events` records that a
  // transition was PUBLISHED to consumers, which is a different fact from the
  // transition itself — the transition is already in this ledger from its own
  // table. Including it as an equal peer would double-count every state change.
  for (const d of sources.domainEvents) {
    add({
      id: `domain-${d.id}`,
      at: d.occurred_at,
      category: "integration",
      actorKind: "system",
      actorLabel: "outbox",
      summary: `Published ${d.event_type} to downstream consumers`,
    });
  }

  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
