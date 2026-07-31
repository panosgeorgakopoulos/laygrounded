// EUA spot price — what a tonne of CO2 actually costs today.
//
// The EU Allowance price is the multiplier on every carbon figure this product
// publishes, and it moves: EUAs have traded across a wide range since the
// maritime phase-in began. A hardcoded number silently misprices every
// addendum, and in a document sent to a counterparty that is a correctable
// error presented as a fact.
//
// Same discipline as the AIS congestion adapter, for the same reason: an
// unconfigured provider is UNAVAILABLE, never a silent guess, and the mock is
// stamped so it cannot be mistaken for a market quote. The one difference is
// that this module has an honest last resort the queue never had — a documented
// static fallback — because a carbon report without a price is useless where a
// speed instruction without a queue is merely absent. That fallback carries its
// own provenance and says what it is.

import type { DataProvenance } from "@/lib/risk/provenance";
import { makeRng } from "@/lib/risk/prng";
import { ETS_DEFAULTS } from "@/lib/compliance/ets";

const FETCH_TIMEOUT_MS = 10_000;

export interface EuaQuote {
  /** EUR per tonne CO2. */
  priceEur: number;
  /** Trading day the quote is for, YYYY-MM-DD. */
  quoteDate: string | null;
  provenance: DataProvenance;
}

/**
 * Sanity band for a quote.
 *
 * A provider returning 0, a negative number, or 4,000 is malfunctioning, and
 * accepting it would put an absurd liability into a legal document. The band is
 * deliberately wide — this rejects nonsense, it does not second-guess the
 * market.
 */
export const PLAUSIBLE_EUA_RANGE = { min: 1, max: 500 } as const;

export function isPlausibleEuaPrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= PLAUSIBLE_EUA_RANGE.min &&
    value <= PLAUSIBLE_EUA_RANGE.max
  );
}

/**
 * Pulls a price out of a provider payload.
 *
 * Providers disagree on shape, so several common paths are tried. Exported
 * because this is the part that breaks when a vendor changes their response,
 * and it is worth pinning without a network call.
 */
export function normalizeEuaQuote(payload: unknown): { price: number; date: string | null } | null {
  if (payload == null || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;

  const candidates: unknown[] = [
    p.price,
    p.close,
    p.last,
    p.settlement,
    p.value,
    p.eua_price_eur,
    p.data?.price,
    p.data?.close,
    Array.isArray(p.data) ? p.data[p.data.length - 1]?.price : undefined,
    Array.isArray(p.results) ? p.results[p.results.length - 1]?.close : undefined,
  ];

  const price = candidates.find(isPlausibleEuaPrice);
  if (price === undefined) return null;

  const rawDate =
    p.date ?? p.quote_date ?? p.timestamp ?? p.data?.date ??
    (Array.isArray(p.data) ? p.data[p.data.length - 1]?.date : undefined);
  const date =
    typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(rawDate)
      ? rawDate.slice(0, 10)
      : null;

  return { price: price as number, date };
}

/**
 * A deterministic synthetic EUA price.
 *
 * Stable within a UTC day and drifting between days, so the carbon figures move
 * like a market without becoming irreproducible — a stored addendum must still
 * render the same number tomorrow. Seeded from the date alone.
 *
 * SYNTHETIC. Stamped `source: "mock"`, which `isDecisionGrade` refuses.
 */
export function mockEuaQuote(dayISO: string): EuaQuote {
  const day = dayISO.slice(0, 10);
  const rng = makeRng(`eua-mock:${day}`);
  // A plausible band around the static default, not a forecast of anything.
  const price = Math.round((60 + rng.next() * 45) * 100) / 100;

  return {
    priceEur: price,
    quoteDate: day,
    provenance: {
      source: "mock",
      provider: "laygrounded-mock-eua",
      observedAt: `${day}T00:00:00.000Z`,
      label: `SYNTHETIC EUA price (€${price.toFixed(2)}/tCO2) from the built-in mock. Not a market quote.`,
    },
  };
}

/** The documented static price, used only when nothing better is available. */
export function staticEuaQuote(): EuaQuote {
  const price = ETS_DEFAULTS.EUA_PRICE_EUR;
  return {
    priceEur: price,
    quoteDate: null,
    provenance: {
      source: "assumption",
      provider: "laygrounded-static-default",
      observedAt: null,
      label: `Static default of €${price}/tCO2 — no carbon-price provider is configured, so this is an assumption rather than a market price.`,
    },
  };
}

export interface CarbonPriceEnv {
  CARBON_PRICE_PROVIDER?: string;
  CARBON_PRICE_URL?: string;
  CARBON_PRICE_KEY?: string;
  ETS_EUA_PRICE_EUR?: string;
  NODE_ENV?: string;
  ALLOW_MOCK_CARBON_PRICE_IN_PRODUCTION?: string;
}

/**
 * Today's EUA price, with its provenance.
 *
 * Resolution order, most trustworthy first:
 *   1. an explicit `ETS_EUA_PRICE_EUR` override — a desk stating its own price;
 *   2. a configured live provider;
 *   3. the mock, if selected and permitted;
 *   4. the documented static default.
 *
 * Never throws: a carbon report with a clearly-labelled assumed price is more
 * useful than no report, which is the opposite of the queue adapter's stance
 * and is stated in the module header.
 */
export async function fetchEuaPrice(
  env: CarbonPriceEnv,
  nowISO: string
): Promise<EuaQuote> {
  const day = nowISO.slice(0, 10);

  const override = parseFloat(env.ETS_EUA_PRICE_EUR ?? "");
  if (isPlausibleEuaPrice(override)) {
    return {
      priceEur: override,
      quoteDate: day,
      provenance: {
        source: "assumption",
        provider: "env-override",
        observedAt: null,
        label: `EUA price of €${override}/tCO2 set explicitly via ETS_EUA_PRICE_EUR.`,
      },
    };
  }

  const provider = (env.CARBON_PRICE_PROVIDER ?? "").trim().toLowerCase();

  if (provider === "mock") {
    const isProduction = (env.NODE_ENV ?? "").toLowerCase() === "production";
    const allowed = (env.ALLOW_MOCK_CARBON_PRICE_IN_PRODUCTION ?? "").trim() === "1";
    // Refused in production for the same reason as mock AIS: a synthetic price
    // in a document sent to a charterer is a fabricated financial figure.
    if (!isProduction || allowed) return mockEuaQuote(day);
    return staticEuaQuote();
  }

  if (provider && env.CARBON_PRICE_URL) {
    try {
      const res = await fetch(env.CARBON_PRICE_URL, {
        headers: env.CARBON_PRICE_KEY ? { Authorization: `Bearer ${env.CARBON_PRICE_KEY}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const quote = normalizeEuaQuote(await res.json());
        if (quote) {
          return {
            priceEur: quote.price,
            quoteDate: quote.date ?? day,
            provenance: {
              source: "live",
              provider,
              observedAt: quote.date ? `${quote.date}T00:00:00.000Z` : null,
              label: `Live EUA spot price €${quote.price.toFixed(2)}/tCO2 from ${provider}${quote.date ? ` (${quote.date})` : ""}.`,
            },
          };
        }
      }
    } catch {
      // Fall through to the static default rather than failing the report.
    }
    return {
      ...staticEuaQuote(),
      provenance: {
        ...staticEuaQuote().provenance,
        unavailableReason: `The ${provider} carbon-price provider could not be reached or returned an unusable quote; the static default was used instead.`,
      },
    };
  }

  return staticEuaQuote();
}
