// Veson IMOS Platform adapter.
//
// IMOS exposes GraphQL for reads (voyage/estimate data) and REST for
// transactional writes; exact schema names vary by tenant configuration and
// API version, so every path and the voyage query are overridable through the
// integration's `config` — the defaults below follow the common IMOS Platform
// shapes. Field mapping stays in one place (`mapVoyage`) for the same reason.

import { ErpAdapter } from "./adapter";
import {
  InboundEvent,
  NormalizedInvoice,
  NormalizedVoyage,
  PushResult,
} from "./types";

interface VesonVoyageNode {
  id?: string;
  voyageNo?: string;
  vesselName?: string;
  vesselImo?: string;
  cargoDescription?: string;
  counterpartyShortName?: string;
  lastUpdated?: string;
  portCalls?: Array<{ portName?: string }>;
}

const DEFAULT_VOYAGE_QUERY = `
  query LaygroundedVoyages($updatedSince: DateTime) {
    voyages(filter: { lastUpdatedAfter: $updatedSince }, first: 100) {
      nodes {
        id
        voyageNo
        vesselName
        vesselImo
        cargoDescription
        counterpartyShortName
        lastUpdated
        portCalls { portName }
      }
    }
  }
`;

export class VesonImosAdapter extends ErpAdapter {
  private cfg(key: string, fallback: string): string {
    const v = this.integration.config[key];
    return typeof v === "string" && v ? v : fallback;
  }

  async pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]> {
    const data = await this.request<{
      data?: { voyages?: { nodes?: VesonVoyageNode[] } };
      errors?: Array<{ message: string }>;
    }>(this.cfg("graphql_path", "/graphql"), {
      body: {
        query: this.cfg("voyage_query", DEFAULT_VOYAGE_QUERY),
        variables: { updatedSince: sinceISO },
      },
    });

    if (data.errors?.length) {
      throw new Error(`IMOS GraphQL errors: ${data.errors.map((e) => e.message).join("; ")}`);
    }

    return (data.data?.voyages?.nodes ?? [])
      .map((n) => this.mapVoyage(n))
      .filter((v): v is NormalizedVoyage => v !== null);
  }

  private mapVoyage(node: VesonVoyageNode): NormalizedVoyage | null {
    if (!node.id || !node.vesselName) return null;
    return {
      externalRef: String(node.id),
      vessel: node.vesselName,
      vesselImo: node.vesselImo || undefined,
      voyageRef: node.voyageNo || String(node.id),
      port: node.portCalls?.[0]?.portName || "Unknown",
      cargo: node.cargoDescription || "Unknown",
      counterpartyName: node.counterpartyShortName || undefined,
      updatedAt: node.lastUpdated,
    };
  }

  async pushInvoice(invoice: NormalizedInvoice): Promise<PushResult> {
    const res = await this.request<{ id?: string }>(
      this.cfg("invoice_path", "/api/v1/laytime/invoices"),
      {
        body: {
          voyageId: invoice.externalRef,
          source: "LAYGROUNDED",
          invoiceType: invoice.kind.toUpperCase(),
          amount: invoice.amount,
          currency: invoice.currency,
          vesselName: invoice.vessel,
          vesselImo: invoice.vesselImo,
          voyageNo: invoice.voyageRef,
          port: invoice.port,
          allowedHours: invoice.allowedHours,
          usedHours: invoice.usedHours,
          computedAt: invoice.computedAt,
        },
      }
    );
    return { externalId: res.id ?? null, raw: res };
  }

  async pushLedger(invoice: NormalizedInvoice): Promise<PushResult> {
    const res = await this.request<{ id?: string }>(
      this.cfg("ledger_path", "/api/v1/laytime/ledgers"),
      {
        body: {
          voyageId: invoice.externalRef,
          source: "LAYGROUNDED",
          claimRef: invoice.claimId,
          entries: invoice.lines.map((l) => ({
            description: l.description,
            clauseRef: l.clauseRef,
            from: l.startTime,
            to: l.endTime,
            hours: l.hours,
            counts: l.counts,
          })),
        },
      }
    );
    return { externalId: res.id ?? null, raw: res };
  }

  parseInboundEvent(payload: unknown): InboundEvent {
    const p = payload as any;
    const eventId = String(p?.eventId ?? p?.id ?? "");
    const type =
      p?.eventType === "voyage.created" || p?.eventType === "voyage.updated"
        ? p.eventType
        : "unknown";
    const voyage = p?.voyage ? this.mapVoyage(p.voyage as VesonVoyageNode) : null;
    return { eventId, type, voyage, raw: payload };
  }
}
