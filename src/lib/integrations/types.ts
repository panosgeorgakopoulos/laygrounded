// Shared types for the ERP integration sync layer.

export type IntegrationProvider =
  | "VESON_IMOS"
  | "DANAOS"
  | "FORTUNE"
  | "ULYSSES"
  | "MOCK_ERP";

/**
 * Whether an adapter's data came from the ERP or from a deterministic fixture.
 *
 * The same discipline the market adapters use (`carbon-price.ts`,
 * `ais-congestion.ts`): provenance travels with the data all the way to the UI,
 * and a mock is REFUSED in production unless its escape hatch is set. A silent
 * mock in an ERP layer is worse than in a price feed — it would invent voyages
 * and book invoices against them.
 */
export type ErpMode = "live" | "mock";

/**
 * What a provider can actually do.
 *
 * Declared rather than discovered, so `enqueueSyncJob` can refuse an
 * unsupported job at the point of request with a 400 the caller can act on,
 * instead of letting it retry six times into a dead letter. Legacy maritime
 * ERPs differ a lot here: some expose schedules, few accept a P&L back.
 */
export interface AdapterCapabilities {
  pullVoyages: boolean;
  pullSchedules: boolean;
  pushInvoice: boolean;
  pushLedger: boolean;
  pushVoyagePnl: boolean;
}

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
    // Danaos-style deployments authenticate the SOAP envelope, not the
    // transport, so username/password are separate from the bearer token.
    username?: string;
    password?: string;
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

/**
 * A forward vessel schedule row — the ERP's view of where a ship is going.
 *
 * Distinct from `NormalizedVoyage`, which is a commercial voyage record that
 * may already be complete. A schedule is the *forward* statement, and it is the
 * only thing here with predictive value: `etaISO` is the input the pre-arrival
 * Monte Carlo and `ecospeed.ts` both need, and today it is typed by hand.
 *
 * Every time field is nullable on purpose. An ERP that has not yet berthed a
 * vessel genuinely has no ETB, and inventing one from the ETA would feed a
 * fabricated number into a risk model.
 */
export interface NormalizedSchedule {
  externalRef: string;
  vessel: string;
  vesselImo?: string;
  voyageRef: string;
  port: string;
  portFunction: "load" | "discharge" | "bunker" | "transit" | "unknown";
  etaISO: string | null;
  /** Estimated time of berthing. Null when the ERP has not scheduled a berth. */
  etbISO: string | null;
  etdISO: string | null;
  laycanFromISO: string | null;
  laycanToISO: string | null;
  cargo: string | null;
  cargoQuantityMt: number | null;
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

/**
 * One line of a voyage P&L as the ERP should book it.
 *
 * `amount` keeps `PnlLine`'s convention exactly — **signed as it affects the
 * result** — and `kind` carries the category. Do not "normalise" this to
 * absolute values plus a direction flag: the sheet's own arithmetic is
 * `grossRevenue − revenueDeductions − voyageExpenses + transfers`, and a
 * re-signed line would reconcile against nothing.
 */
export interface NormalizedPnlLine {
  key: string;
  label: string;
  kind: "revenue" | "deduction" | "expense" | "transfer";
  amount: number;
  currency: string;
  /**
   * True when the line is OUT of the totals (an off-currency item the sheet
   * refused to convert). It must survive the push: an ERP that re-adds an
   * excluded line silently disagrees with our own net result.
   */
  excluded: boolean;
  note: string | null;
}

/**
 * A voyage P&L pushed to the ERP's voyage-result ledger.
 *
 * `warnings` is carried, not dropped. It is how the sheet says it is
 * incomplete — a linked claim with no calculation, an unconvertible currency —
 * and an ERP receiving totals without them would book an authoritative-looking
 * number that our own UI flags as provisional.
 */
export interface NormalizedVoyagePnl {
  externalRef: string | null;
  voyagePnlId: string;
  vessel: string;
  voyageRef: string;
  charterType: string;
  perspective: string;
  currency: string;
  voyageStart: string | null;
  voyageEnd: string | null;
  grossRevenue: number;
  revenueDeductions: number;
  voyageExpenses: number;
  transfers: number;
  netResult: number;
  tcePerDay: number | null;
  voyageDays: number | null;
  computedAt: string;
  lines: NormalizedPnlLine[];
  warnings: string[];
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

/** Thrown when a job asks an adapter for something the provider cannot do. */
export class IntegrationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationUnsupportedError";
  }
}
