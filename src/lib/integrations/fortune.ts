// Fortune Technologies adapter (Fortune Shipping Suite).
//
// !! UNVERIFIED MAPPING !!
// Fortune publishes no open API specification. The shapes below follow the
// common conventions of that product family — JSON/REST, camelCase, a
// `modifiedSince` incremental cursor, envelope-wrapped collections — and have
// never been exercised against a live tenant. Every path and collection key is
// tenant-overridable through `integrations.config` so first contact is a
// configuration change, not a code change. See `danaos.ts` for the same note.
//
// One shape decision worth stating: reads are GET with query parameters rather
// than POST bodies, because an incremental pull must be safely repeatable. If a
// real tenant turns out to require POST for reads, `read_method` flips it
// without touching the mapping.

import { ErpAdapter } from "./adapter";
import { filterSince, mockSchedules, mockVoyages } from "./fixtures";
import { finiteOrNull, mapEventType, mapPortFunction, nullableTime } from "./normalize";
import {
  AdapterCapabilities,
  InboundEvent,
  NormalizedInvoice,
  NormalizedSchedule,
  NormalizedVoyage,
  NormalizedVoyagePnl,
  PushResult,
} from "./types";

interface FortuneVoyage {
  voyageId?: string | number;
  voyageNumber?: string;
  vesselName?: string;
  imoNumber?: string | number;
  cargoType?: string;
  chartererName?: string;
  modifiedOn?: string;
  ports?: Array<{ portName?: string; portFunction?: string }>;
}

interface FortuneSchedule {
  scheduleId?: string | number;
  voyageNumber?: string;
  vesselName?: string;
  imoNumber?: string | number;
  portName?: string;
  portFunction?: string;
  eta?: string;
  etb?: string;
  etd?: string;
  laycanStart?: string;
  laycanEnd?: string;
  cargoType?: string;
  cargoQuantity?: number | string;
  modifiedOn?: string;
}

export class FortuneAdapter extends ErpAdapter {
  get capabilities(): AdapterCapabilities {
    return {
      pullVoyages: true,
      pullSchedules: true,
      pushInvoice: true,
      pushLedger: true,
      pushVoyagePnl: true,
    };
  }

  // --- Pulls ---

  async pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockVoyages(this.integration.id, { prefix: "FOR" }), sinceISO);
    }

    const rows = await this.readCollection<FortuneVoyage>(
      this.cfg("voyages_path", "/api/v1/voyages"),
      sinceISO,
      this.cfg("voyages_key", "voyages")
    );
    return rows.map((r) => this.mapVoyage(r)).filter((v): v is NormalizedVoyage => v !== null);
  }

  async pullSchedules(sinceISO: string | null): Promise<NormalizedSchedule[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockSchedules(this.integration.id, { prefix: "FOR" }), sinceISO);
    }

    const rows = await this.readCollection<FortuneSchedule>(
      this.cfg("schedules_path", "/api/v1/vessel-schedules"),
      sinceISO,
      this.cfg("schedules_key", "schedules")
    );
    return rows.map((r) => this.mapSchedule(r)).filter((s): s is NormalizedSchedule => s !== null);
  }

  /**
   * Reads a collection, tolerating the three envelopes this product family uses:
   * a bare array, `{ <key>: [...] }`, and `{ data: [...] }`.
   *
   * An unrecognised envelope yields `[]`, and that is deliberate: the sync job
   * then reports zero voyages rather than throwing. The alternative — treating
   * a shape mismatch as success with fabricated rows — is unthinkable, and
   * treating it as a hard failure would dead-letter a tenant whose only sin is
   * a differently-named key that `voyages_key` can fix.
   */
  private async readCollection<T>(path: string, sinceISO: string | null, key: string): Promise<T[]> {
    const url = new URL(path, this.integration.base_url);
    if (sinceISO) url.searchParams.set(this.cfg("since_param", "modifiedSince"), sinceISO);
    url.searchParams.set(this.cfg("page_size_param", "pageSize"), this.cfg("page_size", "200"));

    const body = await this.request<unknown>(url.pathname + url.search, {
      method: (this.cfg("read_method", "GET") as "GET" | "POST") ?? "GET",
    });

    if (Array.isArray(body)) return body as T[];
    const env = (body ?? {}) as Record<string, unknown>;
    if (Array.isArray(env[key])) return env[key] as T[];
    if (Array.isArray(env.data)) return env.data as T[];
    return [];
  }

  // --- Mapping ---

  private mapVoyage(row: FortuneVoyage): NormalizedVoyage | null {
    const externalRef = row.voyageId === undefined ? "" : String(row.voyageId);
    const vessel = row.vesselName ?? "";
    // Identity and a vessel are the minimum for an idempotent upsert into a
    // claim. Without them the row is dropped, not defaulted.
    if (!externalRef || !vessel) return null;

    // Prefer the discharge port: it is where demurrage most often accrues.
    const discharge = row.ports?.find((p) => mapPortFunction(p.portFunction) === "discharge");
    return {
      externalRef,
      vessel,
      vesselImo: row.imoNumber === undefined ? undefined : String(row.imoNumber),
      voyageRef: row.voyageNumber || externalRef,
      port: discharge?.portName || row.ports?.[0]?.portName || "Unknown",
      cargo: row.cargoType || "Unknown",
      counterpartyName: row.chartererName || undefined,
      updatedAt: nullableTime(row.modifiedOn) ?? undefined,
    };
  }

  private mapSchedule(row: FortuneSchedule): NormalizedSchedule | null {
    const externalRef = row.scheduleId === undefined ? "" : String(row.scheduleId);
    const vessel = row.vesselName ?? "";
    if (!externalRef || !vessel) return null;

    return {
      externalRef,
      vessel,
      vesselImo: row.imoNumber === undefined ? undefined : String(row.imoNumber),
      voyageRef: row.voyageNumber || externalRef,
      port: row.portName || "Unknown",
      portFunction: mapPortFunction(row.portFunction),
      etaISO: nullableTime(row.eta),
      etbISO: nullableTime(row.etb),
      etdISO: nullableTime(row.etd),
      laycanFromISO: nullableTime(row.laycanStart),
      laycanToISO: nullableTime(row.laycanEnd),
      cargo: row.cargoType || null,
      cargoQuantityMt: finiteOrNull(row.cargoQuantity),
      updatedAt: nullableTime(row.modifiedOn) ?? undefined,
    };
  }

  // --- Pushes ---

  async pushInvoice(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `FOR-MOCK-INV-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const res = await this.request<{ id?: string; invoiceId?: string }>(
      this.cfg("invoice_path", "/api/v1/laytime/demurrage-invoices"),
      {
        body: {
          voyageId: invoice.externalRef,
          source: "LAYGROUNDED",
          externalReference: invoice.claimId,
          invoiceType: invoice.kind.toUpperCase(),
          amount: invoice.amount,
          currency: invoice.currency,
          vesselName: invoice.vessel,
          imoNumber: invoice.vesselImo,
          voyageNumber: invoice.voyageRef,
          portName: invoice.port,
          laytimeAllowedHours: invoice.allowedHours,
          laytimeUsedHours: invoice.usedHours,
          calculatedOn: invoice.computedAt,
        },
      }
    );
    return { externalId: res.invoiceId ?? res.id ?? null, raw: res };
  }

  async pushLedger(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `FOR-MOCK-LED-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const res = await this.request<{ id?: string; statementId?: string }>(
      this.cfg("ledger_path", "/api/v1/laytime/statements"),
      {
        body: {
          voyageId: invoice.externalRef,
          source: "LAYGROUNDED",
          externalReference: invoice.claimId,
          lines: invoice.lines.map((l) => ({
            description: l.description,
            clauseReference: l.clauseRef,
            fromDateTime: l.startTime,
            toDateTime: l.endTime,
            hours: l.hours,
            countsAsLaytime: l.counts,
          })),
        },
      }
    );
    return { externalId: res.statementId ?? res.id ?? null, raw: res };
  }

  async pushVoyagePnl(pnl: NormalizedVoyagePnl): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `FOR-MOCK-PNL-${pnl.voyagePnlId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const res = await this.request<{ id?: string; resultId?: string }>(
      this.cfg("pnl_path", "/api/v1/voyages/results"),
      {
        body: {
          voyageId: pnl.externalRef,
          source: "LAYGROUNDED",
          externalReference: pnl.voyagePnlId,
          vesselName: pnl.vessel,
          voyageNumber: pnl.voyageRef,
          charterType: pnl.charterType,
          perspective: pnl.perspective,
          currency: pnl.currency,
          voyageStart: pnl.voyageStart,
          voyageEnd: pnl.voyageEnd,
          grossRevenue: pnl.grossRevenue,
          revenueDeductions: pnl.revenueDeductions,
          voyageExpenses: pnl.voyageExpenses,
          transfers: pnl.transfers,
          netResult: pnl.netResult,
          tcePerDay: pnl.tcePerDay,
          voyageDays: pnl.voyageDays,
          calculatedOn: pnl.computedAt,
          lines: pnl.lines.map((l) => ({
            key: l.key,
            label: l.label,
            kind: l.kind,
            amount: l.amount,
            currency: l.currency,
            excludedFromTotals: l.excluded,
            note: l.note,
          })),
          // Carried, never dropped: these are how the sheet says it is
          // provisional. See `NormalizedVoyagePnl`.
          warnings: pnl.warnings,
        },
      }
    );
    return { externalId: res.resultId ?? res.id ?? null, raw: res };
  }

  // --- Inbound ---

  parseInboundEvent(payload: unknown): InboundEvent {
    const p = (payload ?? {}) as Record<string, unknown>;
    const voyage = p.voyage ?? p.data;
    return {
      eventId: String(p.eventId ?? p.deliveryId ?? p.id ?? ""),
      type: mapEventType(p.eventType ?? p.event),
      voyage: voyage ? this.mapVoyage(voyage as FortuneVoyage) : null,
      raw: payload,
    };
  }
}
