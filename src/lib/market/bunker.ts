// Pluggable bunker-price feed. Same honest posture as the AIS / weather /
// sanctions providers: when BUNKER_PROVIDER_URL / BUNKER_PROVIDER_KEY are
// unset it returns null — "no live quote" — and callers fall back to their
// documented static default. It never invents a price, because a wrong fuel
// price silently biases every Eco-Speed and fuel-waste recommendation.
//
// The normaliser is pure and unit-tested; only fetchBunkerPrice touches I/O.

import type { MarineFuel } from "@/lib/compliance/emissions";

const FETCH_TIMEOUT_MS = 8000;

// How each grade is spelled in the wild (MarineTraffic / Ship&Bunker / Platts
// exports all differ). Matched case-insensitively against provider keys/labels.
const FUEL_ALIASES: Record<MarineFuel, string[]> = {
  VLSFO: ["vlsfo", "vlsfo380", "lsfo", "ulsfo", "vlsfo0.5"],
  HFO: ["hfo", "ifo380", "ifo", "hsfo", "380cst", "380"],
  MGO: ["mgo", "mdo", "gasoil", "gas oil", "dmgo", "dmb"],
  LNG: ["lng"],
};

const PRICE_KEYS = ["price", "usd", "value", "usd_per_mt", "usd_per_tonne", "usdpermt", "priceusd", "mt"];
const ENVELOPE_KEYS = ["data", "prices", "quotes", "results", "items", "bunkers"];

function asPrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
}

function matchesFuel(label: string, aliases: string[]): boolean {
  const l = label.toLowerCase().replace(/[\s_-]/g, "");
  return aliases.some((a) => l.includes(a.replace(/[\s_-]/g, "")));
}

/**
 * Extracts a USD/tonne price for `fuel` from an arbitrary provider payload.
 * Handles the two shapes the wild produces:
 *   - a flat map keyed by grade: { VLSFO: 620, HFO: 480 } or { vlsfo:{price:620} }
 *   - an array of quotes: [{ grade:"VLSFO", usd_per_mt:620 }, …] possibly under
 *     an envelope key (data / prices / quotes / …)
 * Returns null when no price for the fuel can be read — never a guess.
 */
export function normalizeBunkerQuote(payload: unknown, fuel: MarineFuel): number | null {
  const aliases = FUEL_ALIASES[fuel];
  if (payload == null || typeof payload !== "object") return null;

  // Unwrap a single known envelope key.
  for (const k of ENVELOPE_KEYS) {
    const inner = (payload as Record<string, unknown>)[k];
    if (inner && typeof inner === "object") {
      const hit = normalizeBunkerQuote(inner, fuel);
      if (hit != null) return hit;
    }
  }

  // Array of quote objects.
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const label = String(rec.grade ?? rec.fuel ?? rec.name ?? rec.type ?? rec.product ?? "");
        if (label && matchesFuel(label, aliases)) {
          for (const pk of PRICE_KEYS) {
            const p = asPrice(rec[pk]);
            if (p != null) return p;
          }
        }
      }
    }
    return null;
  }

  // Flat map keyed by grade.
  const rec = payload as Record<string, unknown>;
  for (const [key, val] of Object.entries(rec)) {
    if (!matchesFuel(key, aliases)) continue;
    const direct = asPrice(val);
    if (direct != null) return direct;
    if (val && typeof val === "object") {
      for (const pk of PRICE_KEYS) {
        const p = asPrice((val as Record<string, unknown>)[pk]);
        if (p != null) return p;
      }
    }
  }
  return null;
}

export interface BunkerQuote {
  fuel: MarineFuel;
  pricePerTonneUsd: number;
  port: string | null;
  source: string;
}

/**
 * Live VLSFO/HFO/MGO/LNG price in USD/tonne, or null when no provider is
 * configured or the quote can't be read. `port` is passed to the provider
 * template ({port}) for a port-specific quote where the provider supports it.
 */
export async function fetchBunkerPrice(opts: {
  fuel: MarineFuel;
  port?: string;
}): Promise<BunkerQuote | null> {
  const providerUrl = process.env.BUNKER_PROVIDER_URL;
  const providerKey = process.env.BUNKER_PROVIDER_KEY;
  if (!providerUrl) return null; // honest "no live quote", never a guess

  try {
    const url = providerUrl
      .replace("{fuel}", encodeURIComponent(opts.fuel))
      .replace("{port}", encodeURIComponent(opts.port ?? ""));
    const res = await fetch(url, {
      headers: providerKey ? { Authorization: `Bearer ${providerKey}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const price = normalizeBunkerQuote(await res.json(), opts.fuel);
    if (price == null) return null;
    return { fuel: opts.fuel, pricePerTonneUsd: price, port: opts.port ?? null, source: "provider" };
  } catch {
    return null;
  }
}
