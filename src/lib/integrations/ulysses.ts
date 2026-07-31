// Ulysses Systems adapter (Task Assistant / fleet operations suite).
//
// !! UNVERIFIED MAPPING !!
// Ulysses publishes no open API specification. The shapes below follow that
// product's documented *concepts* — an entity-envelope model where every record
// arrives as `{ entityType, attributes }` rather than as a typed row, and a
// monotonic revision cursor for incremental sync — and have never been
// exercised against a live tenant. Paths and entity names are tenant-overridable
// through `integrations.config`. See `danaos.ts` for the same standing note.
//
// KNOWN GAP — CURSOR SEMANTICS. `ErpAdapter.pullVoyages(sinceISO)` passes a
// TIMESTAMP, because that is what `integrations.last_sync_at` stores. Ulysses'
// native cursor is a revision integer, which is strictly better (monotonic, no
// clock skew, no lost updates inside a same-millisecond window). This adapter
// maps the timestamp onto their `changedSince` filter, which works but gives up
// that guarantee. Supporting a true revision cursor needs a `last_cursor`
// column on `integrations`; it is deliberately NOT faked by stuffing a revision
// into a timestamp field.

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

interface UlyssesEntity {
  entityType?: string;
  entityId?: string | number;
  revision?: number;
  attributes?: Record<string, unknown>;
}

interface UlyssesEnvelope {
  result?: { entities?: UlyssesEntity[]; revision?: number };
  entities?: UlyssesEntity[];
}

export class UlyssesAdapter extends ErpAdapter {
  get capabilities(): AdapterCapabilities {
    return {
      pullVoyages: true,
      pullSchedules: true,
      pushInvoice: true,
      pushLedger: true,
      // Ulysses is an operations/task system rather than a commercial ledger;
      // there is no voyage-result book to receive a P&L. Declared false so the
      // job is refused at enqueue with an actionable error instead of being
      // retried six times into a dead letter.
      pushVoyagePnl: false,
    };
  }

  // --- Pulls ---

  async pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockVoyages(this.integration.id, { prefix: "ULY" }), sinceISO);
    }

    const entities = await this.query(this.cfg("voyage_entity", "Voyage"), sinceISO);
    return entities.map((e) => this.mapVoyage(e)).filter((v): v is NormalizedVoyage => v !== null);
  }

  async pullSchedules(sinceISO: string | null): Promise<NormalizedSchedule[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockSchedules(this.integration.id, { prefix: "ULY" }), sinceISO);
    }

    const entities = await this.query(this.cfg("schedule_entity", "PortCall"), sinceISO);
    return entities
      .map((e) => this.mapSchedule(e))
      .filter((s): s is NormalizedSchedule => s !== null);
  }

  private async query(entityType: string, sinceISO: string | null): Promise<UlyssesEntity[]> {
    const body = await this.request<UlyssesEnvelope | UlyssesEntity[]>(
      this.cfg("query_path", "/api/v2/entities/query"),
      {
        body: {
          entityType,
          changedSince: sinceISO,
          pageSize: Number(this.cfg("page_size", "200")),
        },
      }
    );

    if (Array.isArray(body)) return body;
    const entities = body?.result?.entities ?? body?.entities ?? [];
    // Filter by type: the entity endpoint can return mixed types when a tenant
    // has configured related-entity expansion, and mapping a Berth as a Voyage
    // would produce a claim for a place rather than a ship.
    return entities.filter((e) => !e.entityType || e.entityType === entityType);
  }

  // --- Mapping ---

  private mapVoyage(entity: UlyssesEntity): NormalizedVoyage | null {
    const a = entity.attributes ?? {};
    const externalRef = String(entity.entityId ?? a.voyageId ?? "");
    const vessel = str(a.vesselName ?? a.vessel);
    if (!externalRef || !vessel) return null;

    return {
      externalRef,
      vessel,
      vesselImo: str(a.imo ?? a.imoNumber) || undefined,
      voyageRef: str(a.voyageCode ?? a.voyageNumber) || externalRef,
      port: str(a.portName ?? a.port) || "Unknown",
      cargo: str(a.cargoDescription ?? a.cargo) || "Unknown",
      counterpartyName: str(a.charterer ?? a.counterparty) || undefined,
      updatedAt: nullableTime(a.changedOn ?? a.lastModified) ?? undefined,
    };
  }

  private mapSchedule(entity: UlyssesEntity): NormalizedSchedule | null {
    const a = entity.attributes ?? {};
    const externalRef = String(entity.entityId ?? a.portCallId ?? "");
    const vessel = str(a.vesselName ?? a.vessel);
    if (!externalRef || !vessel) return null;

    return {
      externalRef,
      vessel,
      vesselImo: str(a.imo ?? a.imoNumber) || undefined,
      voyageRef: str(a.voyageCode ?? a.voyageNumber) || externalRef,
      port: str(a.portName ?? a.port) || "Unknown",
      portFunction: mapPortFunction(a.callType ?? a.purpose),
      etaISO: nullableTime(a.eta ?? a.estimatedArrival),
      etbISO: nullableTime(a.etb ?? a.estimatedBerthing),
      etdISO: nullableTime(a.etd ?? a.estimatedDeparture),
      laycanFromISO: nullableTime(a.laycanFrom),
      laycanToISO: nullableTime(a.laycanTo),
      cargo: str(a.cargoDescription ?? a.cargo) || null,
      cargoQuantityMt: finiteOrNull(a.cargoQuantity ?? a.quantityMt),
      updatedAt: nullableTime(a.changedOn ?? a.lastModified) ?? undefined,
    };
  }

  // --- Pushes ---

  async pushInvoice(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `ULY-MOCK-INV-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const res = await this.request<{ entityId?: string; result?: { entityId?: string } }>(
      this.cfg("upsert_path", "/api/v2/entities/upsert"),
      {
        body: {
          entityType: this.cfg("invoice_entity", "DemurrageClaim"),
          externalSystem: "LAYGROUNDED",
          externalId: invoice.claimId,
          attributes: {
            voyageId: invoice.externalRef,
            claimType: invoice.kind,
            amount: invoice.amount,
            currency: invoice.currency,
            vesselName: invoice.vessel,
            imo: invoice.vesselImo,
            voyageCode: invoice.voyageRef,
            portName: invoice.port,
            laytimeAllowedHours: invoice.allowedHours,
            laytimeUsedHours: invoice.usedHours,
            calculatedOn: invoice.computedAt,
          },
        },
      }
    );
    return { externalId: res.result?.entityId ?? res.entityId ?? null, raw: res };
  }

  async pushLedger(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `ULY-MOCK-LED-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const res = await this.request<{ entityId?: string; result?: { entityId?: string } }>(
      this.cfg("upsert_path", "/api/v2/entities/upsert"),
      {
        body: {
          entityType: this.cfg("ledger_entity", "LaytimeStatement"),
          externalSystem: "LAYGROUNDED",
          externalId: `${invoice.claimId}:ledger`,
          attributes: {
            voyageId: invoice.externalRef,
            entries: invoice.lines.map((l) => ({
              description: l.description,
              clauseReference: l.clauseRef,
              from: l.startTime,
              to: l.endTime,
              hours: l.hours,
              countsAsLaytime: l.counts,
            })),
          },
        },
      }
    );
    return { externalId: res.result?.entityId ?? res.entityId ?? null, raw: res };
  }

  // `pushVoyagePnl` is intentionally not implemented — the base class throws
  // IntegrationUnsupportedError, matching `capabilities.pushVoyagePnl = false`.

  // --- Inbound ---

  parseInboundEvent(payload: unknown): InboundEvent {
    const p = (payload ?? {}) as Record<string, unknown>;
    const entity = (p.entity ?? p.data) as UlyssesEntity | undefined;
    return {
      eventId: String(p.notificationId ?? p.eventId ?? ""),
      type: mapEventType(p.eventType ?? p.changeType),
      voyage: entity ? this.mapVoyage(entity) : null,
      raw: payload,
    };
  }
}

/** Attribute bags are `unknown`-valued; coerce only strings and numbers. */
function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
