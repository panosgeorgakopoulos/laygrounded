// Native eFTI / multimodal data bridge — the pure half.
//
// Packages a claim's verified voyage record into a standardized, signed JSON
// consignment payload in the spirit of Regulation (EU) 2020/1056 (electronic
// Freight Transport Information): the dataset a port authority or inland
// logistics provider needs — vessel identity, port call milestones with
// their verification status, laytime outcome — without any of the tenant's
// negotiation internals.
//
// Integrity: the payload is canonicalized (sorted keys) and SHA-256 signed;
// when the claim has a notarized time-proof in compliance_ledger, its Merkle
// root is embedded as the anchor, tying the exported packet to the immutable
// hourly record the notary can independently verify.
//
// Pure module: no I/O, explicit clock. The route owns loading and the
// append-only efti_export ledger entry.

import { canonicalJson, sha256Hex, SNAPSHOT_ALGO } from "@/lib/legal/prosecution";
import type { EventTypeEnum } from "@/lib/laytime/types";

export const EFTI_SCHEMA_VERSION = "laygrounded-efti-1.0";
export const EFTI_SIGNATURE_ALGO = "sha256-canonical-v1";

// Port-call milestones a logistics consumer understands. Laytime internals
// (weather, shifting, hatches, excepted periods) are deliberately NOT
// exported — they are claim-side facts, not transport-chain events.
export const EFTI_MILESTONE_CODES: Partial<Record<EventTypeEnum, string>> = {
  NOR_TENDERED: "NOTICE_OF_READINESS",
  BERTHED: "ARRIVAL_AT_BERTH",
  ALL_FAST: "ALL_FAST",
  COMMENCED_LOADING: "LOADING_COMMENCED",
  COMPLETED_LOADING: "LOADING_COMPLETED",
  COMMENCED_DISCHARGE: "DISCHARGE_COMMENCED",
  COMPLETED_DISCHARGE: "DISCHARGE_COMPLETED",
};

export interface EftiMilestone {
  code: string;
  event_type: EventTypeEnum;
  occurred_at: string;
  // AIS geofence verdict at export time: true / false / null (unchecked).
  geofence_verified: boolean | null;
}

export interface EftiConsignmentInput {
  claim: {
    id: string;
    vessel: string;
    vesselImo: string | null;
    voyageRef: string;
    port: string;
    cargo: string;
    counterpartyName: string | null;
  };
  events: Array<{
    event_type: EventTypeEnum;
    occurred_at: string;
    ais_geofence_verified?: boolean | null;
  }>;
  totals?: {
    allowed_hours: number;
    used_hours: number;
    demurrage_amount: number;
    despatch_amount: number;
    currency: string;
  } | null;
  // Merkle root of the claim's latest notarized time-proof, when one exists.
  anchorMerkleRoot?: string | null;
  generatedAt: string; // explicit clock — determinism
}

export interface EftiConsignment {
  schema: string;
  regulation: string;
  generated_at: string;
  claim_ref: string;
  transport_movement: {
    mode: "maritime";
    vessel_name: string;
    vessel_imo: string | null;
    voyage_ref: string;
  };
  consignment: {
    cargo_description: string;
    counterparty: string | null;
  };
  port_call: {
    port: string;
    milestones: EftiMilestone[];
  };
  laytime_summary: {
    allowed_hours: number;
    used_hours: number;
    demurrage_amount: number;
    despatch_amount: number;
    currency: string;
  } | null;
  integrity: {
    algo: string;
    data_sha256: string;
    anchored_merkle_root: string | null;
    anchor_algo: string | null;
  };
}

// The signature covers everything except the integrity block itself.
function signaturePayload(c: Omit<EftiConsignment, "integrity">): string {
  return sha256Hex(`efti|${c.claim_ref}|${canonicalJson(c)}`);
}

export function buildEftiConsignment(input: EftiConsignmentInput): EftiConsignment {
  if (Number.isNaN(Date.parse(input.generatedAt))) throw new Error("INVALID_GENERATED_AT");

  const milestones: EftiMilestone[] = input.events
    .filter((e) => EFTI_MILESTONE_CODES[e.event_type])
    .map((e) => ({
      code: EFTI_MILESTONE_CODES[e.event_type]!,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      geofence_verified: e.ais_geofence_verified ?? null,
    }))
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  if (milestones.length === 0) throw new Error("NO_EXPORTABLE_MILESTONES");

  const unsigned: Omit<EftiConsignment, "integrity"> = {
    schema: EFTI_SCHEMA_VERSION,
    regulation: "EU 2020/1056 (eFTI)",
    generated_at: input.generatedAt,
    claim_ref: input.claim.id,
    transport_movement: {
      mode: "maritime",
      vessel_name: input.claim.vessel,
      vessel_imo: input.claim.vesselImo,
      voyage_ref: input.claim.voyageRef,
    },
    consignment: {
      cargo_description: input.claim.cargo,
      counterparty: input.claim.counterpartyName,
    },
    port_call: {
      port: input.claim.port,
      milestones,
    },
    laytime_summary: input.totals
      ? {
          allowed_hours: input.totals.allowed_hours,
          used_hours: input.totals.used_hours,
          demurrage_amount: input.totals.demurrage_amount,
          despatch_amount: input.totals.despatch_amount,
          currency: input.totals.currency,
        }
      : null,
  };

  return {
    ...unsigned,
    integrity: {
      algo: EFTI_SIGNATURE_ALGO,
      data_sha256: signaturePayload(unsigned),
      anchored_merkle_root: input.anchorMerkleRoot ?? null,
      anchor_algo: input.anchorMerkleRoot ? SNAPSHOT_ALGO : null,
    },
  };
}

// Recomputes the signature over a received packet. False means the payload
// was altered after signing (or the claim ref does not match).
export function verifyEftiConsignment(consignment: EftiConsignment): boolean {
  const { integrity, ...unsigned } = consignment;
  return integrity.data_sha256 === signaturePayload(unsigned);
}
