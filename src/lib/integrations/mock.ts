// Mock ERP adapter — the test double for the sync engine.
//
// No network: pulls return deterministic voyages, pushes are recorded on a
// static ledger the tests can inspect. Registered as a real provider so the
// whole queue/webhook path can be exercised end-to-end without an IMOS tenant.

import { ErpAdapter } from "./adapter";
import {
  InboundEvent,
  NormalizedInvoice,
  NormalizedVoyage,
  PushResult,
} from "./types";

export class MockErpAdapter extends ErpAdapter {
  // Inspectable from tests: every push lands here, keyed by integration id.
  static pushed: Array<{ integrationId: string; kind: string; invoice: NormalizedInvoice }> = [];
  static failNextPushes = 0;

  static reset(): void {
    MockErpAdapter.pushed = [];
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

  parseInboundEvent(payload: unknown): InboundEvent {
    const p = payload as any;
    return {
      eventId: String(p?.eventId ?? ""),
      type:
        p?.eventType === "voyage.created" || p?.eventType === "voyage.updated"
          ? p.eventType
          : "unknown",
      voyage: p?.voyage ?? null,
      raw: payload,
    };
  }
}
