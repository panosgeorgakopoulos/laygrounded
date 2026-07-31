// Danaos Management Consultants adapter (Danaos Enterprise Suite / WAVES).
//
// !! UNVERIFIED MAPPING !!
// Danaos publishes no open API specification. Unlike `veson.ts`, which follows
// documented IMOS Platform shapes, everything below is written against the
// GENERAL shape of that product generation — a SOAP 1.1 envelope, WS-Security
// UsernameToken authentication, PascalCase elements — and has never been
// exercised against a live tenant. Treat first contact as unverified, exactly
// as `ais-congestion.ts` records for Datalastic.
//
// This is why the SOAP namespace, every operation name and every endpoint path
// are tenant-overridable through `integrations.config`: first contact with a
// real Danaos installation should be a configuration change, not a code change.
// Field mapping stays in one place per entity (`mapVoyage`, `mapSchedule`) for
// the same reason.
//
// KNOWN TRANSPORT LIMITATION. SOAP stacks return HTTP 500 for a Fault, and the
// shared transport treats 5xx as retriable — so a permanent fault (bad voyage
// id) is retried four times before failing. That wastes attempts but never
// corrupts state. Faults returned with HTTP 200, which some stacks do, are
// detected here and thrown immediately.

import { ErpAdapter } from "./adapter";
import { filterSince, mockSchedules, mockVoyages } from "./fixtures";
import { finiteOrNull, mapEventType, mapPortFunction, nullableTime } from "./normalize";
import {
  AdapterCapabilities,
  InboundEvent,
  IntegrationRequestError,
  NormalizedInvoice,
  NormalizedSchedule,
  NormalizedVoyage,
  NormalizedVoyagePnl,
  PushResult,
} from "./types";
import {
  buildXml,
  child,
  childrenNamed,
  findDescendant,
  parseXml,
  textAt,
  XmlElement,
  XmlNode,
} from "./xml";

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const WSSE_NS =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const DEFAULT_NS = "urn:danaos:erp:v1";

export class DanaosAdapter extends ErpAdapter {
  get capabilities(): AdapterCapabilities {
    return {
      pullVoyages: true,
      pullSchedules: true,
      pushInvoice: true,
      pushLedger: true,
      pushVoyagePnl: true,
    };
  }

  private get ns(): string {
    return this.cfg("soap_namespace", DEFAULT_NS);
  }

  private get endpoint(): string {
    return this.cfg("soap_path", "/services/VoyageService.asmx");
  }

  // --- Pulls ---

  async pullVoyages(sinceISO: string | null): Promise<NormalizedVoyage[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockVoyages(this.integration.id, { prefix: "DAN" }), sinceISO);
    }

    const operation = this.cfg("voyages_operation", "GetVoyages");
    const response = await this.call(operation, [
      { name: "UpdatedAfter", text: sinceISO ?? "" },
      { name: "MaxRows", text: this.cfg("page_size", "200") },
    ]);

    const list = findDescendant(response, `${operation}Result`) ?? response;
    return childrenNamed(list, this.cfg("voyage_element", "Voyage"))
      .map((n) => this.mapVoyage(n))
      .filter((v): v is NormalizedVoyage => v !== null);
  }

  async pullSchedules(sinceISO: string | null): Promise<NormalizedSchedule[]> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return filterSince(mockSchedules(this.integration.id, { prefix: "DAN" }), sinceISO);
    }

    const operation = this.cfg("schedules_operation", "GetVesselSchedule");
    const response = await this.call(operation, [
      { name: "UpdatedAfter", text: sinceISO ?? "" },
      { name: "MaxRows", text: this.cfg("page_size", "200") },
    ]);

    const list = findDescendant(response, `${operation}Result`) ?? response;
    return childrenNamed(list, this.cfg("schedule_element", "PortCall"))
      .map((n) => this.mapSchedule(n))
      .filter((s): s is NormalizedSchedule => s !== null);
  }

  // --- Mapping (in one place, on purpose) ---

  private mapVoyage(node: XmlNode): NormalizedVoyage | null {
    const externalRef = textAt(node, "VoyageId") || textAt(node, "Id");
    const vessel = textAt(node, "VesselName") || textAt(node, "Vessel");
    // A voyage without an identity cannot be upserted idempotently, and a
    // voyage without a vessel cannot become a claim. Dropping it is correct;
    // substituting "Unknown" would manufacture a claim against no ship.
    if (!externalRef || !vessel) return null;

    const firstCall = child(child(node, "PortCalls"), "PortCall");
    return {
      externalRef,
      vessel,
      vesselImo: textAt(node, "ImoNumber") || undefined,
      voyageRef: textAt(node, "VoyageNo") || externalRef,
      port: textAt(firstCall, "PortName") || textAt(node, "PortName") || "Unknown",
      cargo: textAt(node, "CargoDescription") || textAt(node, "Cargo") || "Unknown",
      counterpartyName: textAt(node, "ChartererName") || undefined,
      updatedAt: textAt(node, "LastModified") || undefined,
    };
  }

  private mapSchedule(node: XmlNode): NormalizedSchedule | null {
    const externalRef = textAt(node, "PortCallId") || textAt(node, "Id");
    const vessel = textAt(node, "VesselName") || textAt(node, "Vessel");
    if (!externalRef || !vessel) return null;

    return {
      externalRef,
      vessel,
      vesselImo: textAt(node, "ImoNumber") || undefined,
      voyageRef: textAt(node, "VoyageNo") || externalRef,
      port: textAt(node, "PortName") || "Unknown",
      portFunction: mapPortFunction(textAt(node, "CallPurpose")),
      // Empty string is normalised to null, never to `new Date()`. "The ERP has
      // no ETA" and "the ETA is now" are different facts, and the second one
      // would silently become a decision-grade input to the risk engine.
      etaISO: nullableTime(textAt(node, "ETA")),
      etbISO: nullableTime(textAt(node, "ETB")),
      etdISO: nullableTime(textAt(node, "ETD")),
      laycanFromISO: nullableTime(textAt(node, "LaycanFrom")),
      laycanToISO: nullableTime(textAt(node, "LaycanTo")),
      cargo: textAt(node, "CargoDescription") || null,
      cargoQuantityMt: finiteOrNull(textAt(node, "CargoQuantity")),
      updatedAt: textAt(node, "LastModified") || undefined,
    };
  }

  // --- Pushes ---

  async pushInvoice(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `DAN-MOCK-INV-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const operation = this.cfg("invoice_operation", "PostDemurrageInvoice");
    const response = await this.call(operation, [
      { name: "VoyageId", text: invoice.externalRef },
      { name: "Source", text: "LAYGROUNDED" },
      { name: "InvoiceType", text: invoice.kind.toUpperCase() },
      { name: "Amount", text: invoice.amount.toFixed(2) },
      { name: "CurrencyCode", text: invoice.currency },
      { name: "VesselName", text: invoice.vessel },
      { name: "ImoNumber", text: invoice.vesselImo },
      { name: "VoyageNo", text: invoice.voyageRef },
      { name: "PortName", text: invoice.port },
      { name: "LaytimeAllowedHours", text: invoice.allowedHours.toFixed(4) },
      { name: "LaytimeUsedHours", text: invoice.usedHours.toFixed(4) },
      { name: "CalculatedAt", text: invoice.computedAt },
      { name: "ExternalReference", text: invoice.claimId },
    ]);
    return { externalId: resultId(response, operation), raw: { operation } };
  }

  async pushLedger(invoice: NormalizedInvoice): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `DAN-MOCK-LED-${invoice.claimId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const operation = this.cfg("ledger_operation", "PostLaytimeStatement");
    const response = await this.call(operation, [
      { name: "VoyageId", text: invoice.externalRef },
      { name: "Source", text: "LAYGROUNDED" },
      { name: "ClaimReference", text: invoice.claimId },
      {
        name: "Entries",
        children: invoice.lines.map((l) => ({
          name: "Entry",
          children: [
            { name: "Description", text: l.description },
            { name: "ClauseReference", text: l.clauseRef },
            { name: "FromDateTime", text: l.startTime },
            { name: "ToDateTime", text: l.endTime },
            { name: "Hours", text: l.hours.toFixed(4) },
            // The engine's verdict on whether this row counts against laytime.
            // Serialized as the string the SOAP schema of this era expects.
            { name: "CountsAsLaytime", text: l.counts ? "true" : "false" },
          ],
        })),
      },
    ]);
    return { externalId: resultId(response, operation), raw: { operation } };
  }

  async pushVoyagePnl(pnl: NormalizedVoyagePnl): Promise<PushResult> {
    if (this.mode === "mock") {
      this.assertModeAllowed();
      return { externalId: `DAN-MOCK-PNL-${pnl.voyagePnlId.slice(0, 8)}`, raw: { mocked: true } };
    }

    const operation = this.cfg("pnl_operation", "PostVoyageResult");
    const response = await this.call(operation, [
      { name: "VoyageId", text: pnl.externalRef },
      { name: "Source", text: "LAYGROUNDED" },
      { name: "VesselName", text: pnl.vessel },
      { name: "VoyageNo", text: pnl.voyageRef },
      { name: "CurrencyCode", text: pnl.currency },
      { name: "GrossRevenue", text: pnl.grossRevenue.toFixed(2) },
      { name: "RevenueDeductions", text: pnl.revenueDeductions.toFixed(2) },
      { name: "VoyageExpenses", text: pnl.voyageExpenses.toFixed(2) },
      { name: "Transfers", text: pnl.transfers.toFixed(2) },
      { name: "NetResult", text: pnl.netResult.toFixed(2) },
      { name: "TcePerDay", text: pnl.tcePerDay === null ? null : pnl.tcePerDay.toFixed(2) },
      { name: "VoyageDays", text: pnl.voyageDays === null ? null : pnl.voyageDays.toFixed(4) },
      { name: "CalculatedAt", text: pnl.computedAt },
      {
        name: "Lines",
        children: pnl.lines.map((l) => ({
          name: "Line",
          children: [
            { name: "Key", text: l.key },
            { name: "Label", text: l.label },
            { name: "Kind", text: l.kind },
            { name: "Amount", text: l.amount.toFixed(2) },
            { name: "CurrencyCode", text: l.currency },
            // Carried so the ERP does not re-add a line our own totals exclude.
            { name: "ExcludedFromTotals", text: l.excluded ? "true" : "false" },
          ],
        })),
      },
      {
        name: "Warnings",
        children: pnl.warnings.map((w) => ({ name: "Warning", text: w })),
      },
    ]);
    return { externalId: resultId(response, operation), raw: { operation } };
  }

  // --- Inbound ---

  parseInboundEvent(payload: unknown): InboundEvent {
    // Danaos webhook bridges post the SOAP notification body as a raw string.
    if (typeof payload === "string") {
      let doc: XmlNode;
      try {
        // The same hardened parser as responses: DOCTYPE/ENTITY refused. A
        // malformed or hostile body degrades to `unknown` with no eventId,
        // which the webhook route rejects — it never throws past this point.
        doc = parseXml(payload);
      } catch {
        return { eventId: "", type: "unknown", voyage: null, raw: payload };
      }
      const notification = findDescendant(doc, "VoyageNotification") ?? doc;
      const voyageNode = child(notification, "Voyage");
      return {
        eventId: textAt(notification, "NotificationId") || textAt(notification, "EventId"),
        type: mapEventType(textAt(notification, "EventType")),
        voyage: voyageNode ? this.mapVoyage(voyageNode) : null,
        raw: payload,
      };
    }

    const p = (payload ?? {}) as Record<string, unknown>;
    return {
      eventId: String(p.notificationId ?? p.eventId ?? ""),
      type: mapEventType(String(p.eventType ?? "")),
      voyage: null,
      raw: payload,
    };
  }

  // --- SOAP plumbing ---

  private async call(operation: string, fields: XmlElement[]): Promise<XmlNode> {
    const envelope = buildXml({
      name: "soap:Envelope",
      attrs: { "xmlns:soap": SOAP_NS },
      children: [
        this.securityHeader(),
        {
          name: "soap:Body",
          children: [
            {
              name: operation,
              attrs: { xmlns: this.ns },
              children: fields,
            },
          ],
        },
      ],
    });

    const response = await this.requestXml(this.endpoint, {
      rawBody: envelope,
      headers: { SOAPAction: `${this.ns}/${operation}` },
    });

    assertNoSoapFault(response);
    return findDescendant(response, "Body") ?? response;
  }

  private securityHeader(): XmlElement | null {
    const { username, password } = this.integration.auth;
    if (!username) return null;
    return {
      name: "soap:Header",
      children: [
        {
          name: "wsse:Security",
          attrs: { "xmlns:wsse": WSSE_NS },
          children: [
            {
              name: "wsse:UsernameToken",
              children: [
                { name: "wsse:Username", text: username },
                { name: "wsse:Password", text: password ?? "" },
              ],
            },
          ],
        },
      ],
    };
  }
}

/**
 * Throws on a SOAP Fault delivered with HTTP 200.
 *
 * A Fault is a permanent, non-retriable failure; surfacing it as an error here
 * means the sync job records the faultstring rather than "succeeded" with an
 * empty result set.
 */
function assertNoSoapFault(doc: XmlNode): void {
  const fault = findDescendant(doc, "Fault");
  if (!fault) return;
  const message =
    textAt(fault, "faultstring") || textAt(fault, "Reason", "Text") || "unspecified SOAP fault";
  const code = textAt(fault, "faultcode") || textAt(fault, "Code", "Value");
  throw new IntegrationRequestError(`Danaos SOAP fault${code ? ` [${code}]` : ""}: ${message}`);
}

function resultId(doc: XmlNode, operation: string): string | null {
  const result = findDescendant(doc, `${operation}Result`) ?? doc;
  return textAt(result, "Id") || textAt(result, "DocumentId") || result.text || null;
}

