// Mock ERP adapter — the test double for the sync engine.
//
// No network: pulls return deterministic voyages, pushes are recorded on a
// static ledger the tests can inspect. Registered as a real provider so the
// whole queue/webhook path can be exercised end-to-end without an IMOS tenant.

import { ErpAdapter } from "./adapter";
import { mapEventType } from "./normalize";
import {
  AdapterCapabilities,
  ErpMode,
  InboundEvent,
  NormalizedInvoice,
  NormalizedSchedule,
  NormalizedVoyage,
  NormalizedVoyagePnl,
  PushResult,
} from "./types";

export class MockErpAdapter extends ErpAdapter {
  get capabilities(): AdapterCapabilities {
    return {
      pullVoyages: true,
      pullSchedules: true,
      pushInvoice: true,
      pushLedger: true,
      pushVoyagePnl: true,
    };
  }

  /**
   * Always mock, whatever `config.mode` says.
   *
   * MOCK_ERP has no live endpoint it could reach, so reporting "live" would be
   * a lie that propagates into `webhook_logs` and the UI's provenance badge.
   *
   * It deliberately does NOT call `assertModeAllowed()`. The production refusal
   * exists to stop an integration that LOOKS connected from inventing voyages —
   * a `DANAOS` row in mock mode is exactly that, whereas `MOCK_ERP` is
   * self-labelling and a user had to choose it by name. Guarding the first and
   * not the second is the distinction that matters; adding the guard here would
   * only break existing demo tenants to no security end.
   */
  get mode(): ErpMode {
    return "mock";
  }

  // Inspectable from tests: every push lands here, keyed by integration id.
  static pushed: Array<{ integrationId: string; kind: string; invoice: NormalizedInvoice }> = [];
  static failNextPushes = 0;

  static reset(): void {
    MockErpAdapter.pushed = [];
    MockErpAdapter.pushedPnl = [];
    MockErpAdapter.failNextPushes = 0;
  }

  async pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]> {
    return [
      {
        externalRef: "MOCK-VOY-1001",
        vessel: "MOCK CARRIER",
        vesselImo: "9700001",
        voyageRef: "M-1001",
        port: "Rotterdam",
        cargo: "Steam coal",
        counterpartyName: "Mock Chartering BV",
        updatedAt: sinceISO ?? new Date().toISOString(),
      },
    ];
  }

  async pullSchedules(_sinceISO: string | null): Promise<NormalizedSchedule[]> {
    return [
      {
        externalRef: "MOCK-SCH-2001",
        vessel: "MOCK CARRIER",
        vesselImo: "9700001",
        voyageRef: "M-1001",
        port: "Rotterdam",
        portFunction: "discharge",
        etaISO: "2026-08-04T06:00:00.000Z",
        // Deliberately null: a schedule with no berth assigned yet is the
        // common case, and consumers must handle it.
        etbISO: null,
        etdISO: null,
        laycanFromISO: "2026-08-02T00:00:00.000Z",
        laycanToISO: "2026-08-09T00:00:00.000Z",
        cargo: "Steam coal",
        cargoQuantityMt: 72_000,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ];
  }

  private recordPush(kind: string, invoice: NormalizedInvoice): PushResult {
    if (MockErpAdapter.failNextPushes > 0) {
      MockErpAdapter.failNextPushes--;
      throw new Error("MOCK_ERP transient failure (injected)");
    }
    MockErpAdapter.pushed.push({ integrationId: this.integration.id, kind, invoice });
    return { externalId: `mock-${kind}-${MockErpAdapter.pushed.length}`, raw: {} };
  }

  async pushInvoice(invoice: NormalizedInvoice): Promise<PushResult> {
    return this.recordPush("invoice", invoice);
  }

  async pushLedger(invoice: NormalizedInvoice): Promise<PushResult> {
    return this.recordPush("ledger", invoice);
  }

  // Inspectable separately from invoice pushes — a P&L is a different document.
  static pushedPnl: NormalizedVoyagePnl[] = [];

  async pushVoyagePnl(pnl: NormalizedVoyagePnl): Promise<PushResult> {
    if (MockErpAdapter.failNextPushes > 0) {
      MockErpAdapter.failNextPushes--;
      throw new Error("MOCK_ERP transient failure (injected)");
    }
    MockErpAdapter.pushedPnl.push(pnl);
    return { externalId: `mock-pnl-${MockErpAdapter.pushedPnl.length}`, raw: {} };
  }

  parseInboundEvent(payload: unknown): InboundEvent {
    const p = (payload ?? {}) as Record<string, unknown>;
    return {
      eventId: String(p.eventId ?? ""),
      type: mapEventType(p.eventType),
      voyage: (p.voyage as NormalizedVoyage | undefined) ?? null,
      raw: payload,
    };
  }
}
