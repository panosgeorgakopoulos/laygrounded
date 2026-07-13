// Shared types for the ERP integration sync layer.

export type IntegrationProvider = "VESON_IMOS" | "MOCK_ERP";

export interface IntegrationRow {
  id: string;
  company_id: string;
  provider: IntegrationProvider;
  display_name: string;
  base_url: string;
  // Server-side only — never serialized to API responses.
  auth: {
    api_token?: string;
    webhook_secret?: string;
  };
  config: Record<string, unknown>;
  status: "active" | "paused" | "error";
  last_error: string | null;
  last_sync_at: string | null;
}

// The provider-neutral voyage shape every adapter maps into. This is the
// contract the rest of LayGrounded sees; provider-specific field names stay
// inside the adapter.
export interface NormalizedVoyage {
  externalRef: string;
  vessel: string;
  vesselImo?: string;
  voyageRef: string;
  port: string;
  cargo: string;
  counterpartyName?: string;
  updatedAt?: string;
}

export interface NormalizedInvoiceLine {
  description: string;
  clauseRef: string;
  startTime: string;
  endTime: string;
  hours: number;
  counts: boolean;
}

// Finalized demurrage/despatch invoice pushed back to the ERP.
export interface NormalizedInvoice {
  externalRef: string | null;
  claimId: string;
  vessel: string;
  vesselImo: string | null;
  voyageRef: string;
  port: string;
  kind: "demurrage" | "despatch";
  amount: number;
  currency: string;
  allowedHours: number;
  usedHours: number;
  computedAt: string;
  lines: NormalizedInvoiceLine[];
}

// Provider-neutral inbound webhook event after adapter parsing.
export interface InboundEvent {
  // Provider's stable delivery/event id — the idempotency key.
  eventId: string;
  type: "voyage.created" | "voyage.updated" | "unknown";
  voyage: NormalizedVoyage | null;
  raw: unknown;
}

export interface PushResult {
  externalId: string | null;
  raw: unknown;
}

export class IntegrationAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationAuthError";
  }
}

export class IntegrationRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "IntegrationRequestError";
  }
}
