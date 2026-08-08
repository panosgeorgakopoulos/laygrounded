// The counterparty statement view: a read-only projection of a claim.
//
// WHAT THIS IS FOR, AND HOW IT DIFFERS FROM A CLAIM ROOM.
//
// `rooms.ts` builds a NEGOTIATION surface: the counterparty files proposals and
// both sides watch a redline move. This builds an EVIDENCE surface: here is the
// calculation, here is the timeline it came from, here is the vessel's track,
// and here is the fingerprint of the engine that produced the figure. The
// reader changes nothing. Two different conversations, so two different
// projections and two different share modes.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────
//
// EVERY FIELD IS COPIED ACROSS BY NAME. No spreads, no `select("*")`, no
// `...claim`. That is not stylistic. A claim row carries `company_id`,
// `created_by`, `settled_amount`, `agreed_by`, `negotiation_opened_at` — the
// last of which tells a counterparty exactly when the owner started preparing
// to fight, and `settled_amount` tells them what the owner accepted on a
// DIFFERENT claim's terms. A single `...claim` here hands all of it to the
// opposing party in a live dispute, over the network, where no amount of
// careful rendering can take it back.
//
// The defence is structural rather than diligent: `statement-view.test.ts`
// serialises a view built from a row stuffed with every internal field and
// fails if any of them appears anywhere in the JSON. Adding a column to
// `claims` therefore cannot leak here by accident — it can only leak if
// somebody writes the field name into this file on purpose.
//
// Internal data that is NOT in the projection and must never be added:
//   * negotiation mandate / concession bounds (`claim_negotiation_state`) —
//     the counterparty learning the owner's walk-away number ends the
//     negotiation on the spot;
//   * notifications and voyage alerts — internal team chatter;
//   * drafts and legal positions;
//   * security events, audit trail, ERP refs, company or user identifiers;
//   * `event_proposals` — a dispute in flight is negotiation, not evidence,
//     and this surface is not where it belongs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BreakdownRow, CalculationTotals } from "@/lib/laytime/types";
import { readVerifierManifest } from "@/lib/finance/verifier-manifest";
import { resolveClaimEngineVersion } from "@/lib/laytime/engine-version";

/** What the counterparty is told about the claim itself. */
export interface StatementClaim {
  vessel: string;
  voyageRef: string;
  port: string;
  terminal: string | null;
  cargo: string;
  cpForm: string;
  /** Whether the vessel's position track can be plotted at all. */
  portLat: number | null;
  portLon: number | null;
}

/**
 * The commercial terms the figure was computed under.
 *
 * Included deliberately, and it is the one judgement call in this file that
 * could look like a leak. It is not: these are the CHARTERPARTY terms — the
 * laytime allowance, the demurrage rate, the days basis — and the counterparty
 * is a party to that charterparty. They already have them. Withholding them
 * would produce a statement whose arithmetic cannot be checked, which defeats
 * the entire purpose of sending it.
 */
export interface StatementTerms {
  laytimeAllowedHours: number | null;
  turnTimeHours: number | null;
  demurrageRate: number | null;
  despatchRate: number | null;
  daysBasis: string | null;
  norVariant: string | null;
  currency: string | null;
}

export interface StatementEvent {
  occurredAt: string;
  eventType: string;
  rawText: string;
  /** `vision`, `text`, `manual` — provenance, so a reader can weigh a line. */
  source: string;
}

export interface StatementCalculation {
  computedAt: string;
  totals: CalculationTotals;
  breakdown: BreakdownRow[];
}

/**
 * The engine fingerprint.
 *
 * The point of the whole surface: a counterparty can take the conformance root,
 * run the published verifier against the corresponding suite, and satisfy
 * themselves that the rules behind the figure are the rules that were
 * published — without trusting this application at all.
 *
 * `engineVersion` travels with it because each rule set has its OWN root, and a
 * reader handed the wrong pairing would run the wrong suite, get a match, and
 * conclude they had attested the engine behind the number. They would not have.
 */
export interface StatementVerifier {
  engineVersion: 1 | 2;
  verifierVersion: string;
  conformanceRoot: string;
  conformanceCases: number;
  wasmSha256: string;
  /** False when the build artefact is absent — never silently shown as valid. */
  available: boolean;
}

export interface StatementPosition {
  timestamp: string;
  lat: number;
  lon: number;
}

export interface StatementView {
  share: {
    counterpartyLabel: string;
    expiresAt: string;
    /** Always "readonly" here. Present so the UI cannot mistake the surface. */
    accessMode: "readonly";
  };
  claim: StatementClaim;
  terms: StatementTerms;
  calculation: StatementCalculation | null;
  events: StatementEvent[];
  verifier: StatementVerifier;
  /** Null when no AIS provider is configured — "we could not look", not "she did not move". */
  track: StatementPosition[] | null;
  generatedAt: string;
}

/** Narrow an unknown jsonb blob to a number without inventing one. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Builds the projection.
 *
 * Takes already-loaded rows rather than doing its own I/O, so the allowlist can
 * be tested against a row containing every internal field in the schema without
 * a database. The caller (`statement-view-server.ts`) does the loading.
 */
export function buildStatementView(input: {
  share: { counterparty_label: string; expires_at: string };
  claim: Record<string, unknown>;
  calculation: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  track: StatementPosition[] | null;
  now?: Date;
}): StatementView {
  const { share, claim, calculation, events, track } = input;

  // The rule set this claim's figures were produced under. `claims.engine_version`
  // is the authority; absence means 1.
  const engineVersion = resolveClaimEngineVersion({
    engine_version: claim.engine_version as number | null | undefined,
  });
  const manifest = readVerifierManifest(engineVersion);

  const cpTerms = (claim.cp_terms ?? {}) as Record<string, unknown>;

  return {
    share: {
      counterpartyLabel: share.counterparty_label,
      expiresAt: share.expires_at,
      accessMode: "readonly",
    },

    claim: {
      vessel: (claim.vessel as string) ?? "",
      voyageRef: (claim.voyage_ref as string) ?? "",
      port: (claim.port as string) ?? "",
      terminal: str(claim.terminal_name),
      cargo: (claim.cargo as string) ?? "",
      cpForm: (claim.cp_form as string) ?? "GENCON94",
      portLat: num(claim.port_lat),
      portLon: num(claim.port_lon),
    },

    // Key names taken from `CpTerms` in the engine package, NOT invented. The
    // first draft of this file guessed `laytime_allowance_hours` and
    // `demurrage_rate_per_day`; every one of them read as null, the whole terms
    // block rendered as em-dashes, and no test caught it because the leakage
    // suite asserts what is ABSENT and nothing asserted what is present. Only
    // looking at the rendered page did.
    terms: {
      laytimeAllowedHours: num(cpTerms.laytime_allowed_hours),
      turnTimeHours: num(cpTerms.turn_time_hours),
      demurrageRate: num(cpTerms.demurrage_rate),
      despatchRate: num(cpTerms.despatch_rate),
      daysBasis: str(cpTerms.days_basis),
      norVariant: str(cpTerms.nor_variant),
      currency: str(cpTerms.currency),
    },

    calculation: calculation
      ? {
          computedAt: (calculation.computed_at as string) ?? "",
          totals: {
            allowed_hours: num(calculation.allowed_hours) ?? 0,
            used_hours: num(calculation.used_hours) ?? 0,
            time_on_demurrage_hours: num(calculation.time_on_demurrage_hours) ?? 0,
            time_saved_hours: num(calculation.time_saved_hours) ?? 0,
            ...(num(calculation.demurrage_half_rate_hours) !== null
              ? { demurrage_half_rate_hours: num(calculation.demurrage_half_rate_hours)! }
              : {}),
            demurrage_amount: num(calculation.demurrage_amount) ?? 0,
            despatch_amount: num(calculation.despatch_amount) ?? 0,
            currency: str(calculation.currency) ?? "USD",
          },
          // Row-by-row rather than passed through: the stored `breakdown` jsonb
          // is engine output today, but it is a blob, and a blob that gets
          // handed to a counterparty untouched is one schema change away from
          // carrying something it should not.
          breakdown: Array.isArray(calculation.breakdown)
            ? (calculation.breakdown as Array<Record<string, unknown>>).map((r) => ({
                start_time: (r.start_time as string) ?? "",
                end_time: (r.end_time as string) ?? "",
                duration_hours: num(r.duration_hours) ?? 0,
                status: (r.status as BreakdownRow["status"]) ?? "laytime",
                counts: Boolean(r.counts),
                clause_ref: (r.clause_ref as string) ?? "",
                reasoning: (r.reasoning as string) ?? "",
              }))
            : [],
        }
      : null,

    // Confirmed events only. A `suggested` event has not been reviewed by a
    // human, and sending an unreviewed machine extraction to the opposing party
    // as though it were the owner's position is how a claim gets undermined by
    // its own evidence pack.
    events: events.map((e) => ({
      occurredAt: (e.occurred_at as string) ?? "",
      eventType: (e.event_type as string) ?? "",
      rawText: (e.raw_text as string) ?? "",
      source: (e.source as string) ?? "",
    })),

    verifier: {
      engineVersion,
      verifierVersion: manifest.version,
      conformanceRoot: manifest.conformanceRoot,
      conformanceCases: manifest.conformanceCases,
      wasmSha256: manifest.wasmSha256,
      // An absent manifest reports empty digests rather than throwing. Saying
      // so explicitly stops a missing build artefact from reading as a verified
      // one — the reader must be able to tell "unavailable" from "checked".
      available: Boolean(manifest.conformanceRoot),
    },

    track,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}
