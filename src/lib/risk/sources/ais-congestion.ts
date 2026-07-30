// Port congestion from live AIS.
//
// WHY EXTERNAL AIS RATHER THAN OUR OWN BOOK: the cross-tenant congestion
// matview (`port_congestion_stats`) is the natural source, but it is governed
// by k-anonymity floors — five voyages and three companies per bucket — and
// today holds three rows from one tenant, so every bucket is suppressed. Those
// floors are correct and must not be lowered to feed a simulation. Live AIS is
// external observation of public vessel positions rather than an aggregate of
// other tenants' commercial data, so it carries no such constraint and works on
// day one.
//
// The provider shape here is Datalastic's. The mapping is written against their
// documented `port_congestion` response; it has NOT been exercised against the
// live endpoint (no key), so `parseDatalasticPayload` is deliberately defensive
// and returns null rather than guessing when a field is missing or unusable.

import type { DataProvenance } from "@/lib/risk/provenance";

export interface PortCongestionSnapshot {
  portKey: string;
  portLabel: string;
  /** When the provider observed this. */
  observedAt: string;
  vesselsAtAnchorage: number;
  vesselsInPort: number | null;
  /**
   * Observed berth waiting times in hours, ASCENDING.
   *
   * The empirical distribution IS the model. A port where most ships berth on
   * arrival but one in eight waits four days is not described by any mean, and
   * the mean is precisely the number that would understate the tail that
   * generates demurrage.
   */
  waitingHoursSorted: number[];
  provenance: DataProvenance;
}

export interface AisCongestionAdapter {
  readonly id: string;
  /** Returns null when the port is unknown or the provider is unreachable. */
  fetchSnapshot(port: string): Promise<PortCongestionSnapshot | null>;
}

export function normalizePortKey(port: string): string {
  return port.trim().toLowerCase();
}

const DATALASTIC_BASE = "https://api.datalastic.com/api/v0";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Datalastic's congestion response, as documented.
 *
 * Typed loosely on purpose: this is an outside system whose shape we do not
 * control, and a strict interface would turn a harmless extra field into a
 * runtime failure. Validation happens in the parser, once.
 */
interface DatalasticCongestionResponse {
  data?: {
    port_name?: string;
    unlocode?: string;
    vessels_at_anchorage?: number;
    vessels_in_port?: number;
    /** Per-vessel records; the field name varies by plan tier. */
    anchorage_vessels?: Array<{ waiting_time_hours?: number; wait_hours?: number }>;
    average_waiting_time_hours?: number;
    last_updated?: string;
  };
}

/**
 * Maps a Datalastic payload to a snapshot, or null if it cannot support one.
 *
 * Exported so the shape can be tested without a key — the parsing is the part
 * that will break when the provider changes, so it is the part worth pinning.
 */
export function parseDatalasticPayload(
  payload: unknown,
  port: string
): Omit<PortCongestionSnapshot, "provenance"> | null {
  const data = (payload as DatalasticCongestionResponse)?.data;
  if (!data) return null;

  const perVessel = (data.anchorage_vessels ?? [])
    .map((v) => v.waiting_time_hours ?? v.wait_hours)
    .filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h >= 0);

  // Per-vessel waits are what we want; they ARE the empirical distribution.
  // An average alone cannot substitute for one — expanding a mean into a fake
  // spread would manufacture exactly the tail behaviour the simulation is
  // supposed to measure — so a payload with only an average is refused.
  if (perVessel.length === 0) return null;

  const anchorage =
    typeof data.vessels_at_anchorage === "number"
      ? data.vessels_at_anchorage
      : perVessel.length;

  return {
    portKey: normalizePortKey(port),
    portLabel: data.port_name ?? port,
    observedAt: data.last_updated ?? new Date().toISOString(),
    vesselsAtAnchorage: anchorage,
    vesselsInPort: typeof data.vessels_in_port === "number" ? data.vessels_in_port : null,
    waitingHoursSorted: [...perVessel].sort((a, b) => a - b),
  };
}

export function createDatalasticAdapter(apiKey: string): AisCongestionAdapter {
  return {
    id: "datalastic",
    async fetchSnapshot(port: string): Promise<PortCongestionSnapshot | null> {
      const url =
        `${DATALASTIC_BASE}/port_congestion?api-key=${encodeURIComponent(apiKey)}` +
        `&port_name=${encodeURIComponent(port.split(",")[0].trim())}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return null;
        const parsed = parseDatalasticPayload(await res.json(), port);
        if (!parsed) return null;
        return {
          ...parsed,
          provenance: {
            source: "live",
            provider: "datalastic",
            observedAt: parsed.observedAt,
            label: `Live AIS port congestion from Datalastic, observed ${parsed.observedAt}`,
          },
        };
      } catch {
        // A provider outage is "unavailable", never "no congestion". Returning
        // an empty queue here would silently price every fixture as if the
        // berth were free.
        return null;
      }
    },
  };
}
