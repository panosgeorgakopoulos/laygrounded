import { describe, expect, test } from "bun:test";
import {
  fetchEuaPrice,
  isPlausibleEuaPrice,
  mockEuaQuote,
  normalizeEuaQuote,
  staticEuaQuote,
  PLAUSIBLE_EUA_RANGE,
} from "@/lib/market/carbon-price";

const NOW = "2026-07-31T09:00:00.000Z";

describe("normalizeEuaQuote", () => {
  test("reads the common provider shapes", () => {
    expect(normalizeEuaQuote({ price: 82.4 })?.price).toBe(82.4);
    expect(normalizeEuaQuote({ close: 79 })?.price).toBe(79);
    expect(normalizeEuaQuote({ data: { price: 88.15 } })?.price).toBe(88.15);
    expect(normalizeEuaQuote({ data: [{ price: 70 }, { price: 91 }] })?.price).toBe(91);
    expect(normalizeEuaQuote({ results: [{ close: 66.5 }] })?.price).toBe(66.5);
  });

  test("extracts a quote date when one is present", () => {
    expect(normalizeEuaQuote({ price: 82, date: "2026-07-30" })?.date).toBe("2026-07-30");
    expect(normalizeEuaQuote({ price: 82, date: "2026-07-30T12:00:00Z" })?.date).toBe("2026-07-30");
    expect(normalizeEuaQuote({ price: 82 })?.date).toBeNull();
  });

  test("REJECTS implausible prices rather than putting them in a legal document", () => {
    // A provider returning 0, a negative, or 4000 is malfunctioning. Accepting
    // it would print an absurd liability on a document sent to a counterparty.
    for (const bad of [0, -50, 4000, NaN, Infinity, "82.4", null, undefined]) {
      expect(normalizeEuaQuote({ price: bad })).toBeNull();
    }
  });

  test("returns null for junk", () => {
    expect(normalizeEuaQuote(null)).toBeNull();
    expect(normalizeEuaQuote("nope")).toBeNull();
    expect(normalizeEuaQuote({})).toBeNull();
    expect(normalizeEuaQuote({ unrelated: 5 })).toBeNull();
  });

  test("the plausibility band is wide enough not to second-guess the market", () => {
    expect(isPlausibleEuaPrice(PLAUSIBLE_EUA_RANGE.min)).toBe(true);
    expect(isPlausibleEuaPrice(PLAUSIBLE_EUA_RANGE.max)).toBe(true);
    expect(isPlausibleEuaPrice(150)).toBe(true);
  });
});

describe("mock quote", () => {
  test("is deterministic within a UTC day", () => {
    // A stored addendum must render the same number tomorrow.
    expect(mockEuaQuote("2026-07-31T01:00:00.000Z").priceEur).toBe(
      mockEuaQuote("2026-07-31T23:00:00.000Z").priceEur
    );
  });

  test("moves between days", () => {
    expect(mockEuaQuote("2026-07-31").priceEur).not.toBe(mockEuaQuote("2026-08-01").priceEur);
  });

  test("stays inside the plausible band", () => {
    for (let d = 1; d <= 28; d++) {
      const q = mockEuaQuote(`2026-02-${String(d).padStart(2, "0")}`);
      expect(isPlausibleEuaPrice(q.priceEur)).toBe(true);
    }
  });

  test("is stamped synthetic and can never be decision-grade", () => {
    const q = mockEuaQuote("2026-07-31");
    expect(q.provenance.source).toBe("mock");
    expect(q.provenance.label).toContain("SYNTHETIC");
  });
});

describe("resolution order", () => {
  test("an explicit env override wins over everything", async () => {
    const q = await fetchEuaPrice(
      { ETS_EUA_PRICE_EUR: "95.5", CARBON_PRICE_PROVIDER: "mock" },
      NOW
    );
    expect(q.priceEur).toBe(95.5);
    expect(q.provenance.provider).toBe("env-override");
  });

  test("an implausible override is ignored rather than trusted", async () => {
    const q = await fetchEuaPrice({ ETS_EUA_PRICE_EUR: "-5" }, NOW);
    expect(q.priceEur).toBeGreaterThan(0);
    expect(q.provenance.provider).not.toBe("env-override");
  });

  test("mock is selected outside production", async () => {
    const q = await fetchEuaPrice({ CARBON_PRICE_PROVIDER: "mock", NODE_ENV: "development" }, NOW);
    expect(q.provenance.source).toBe("mock");
  });

  test("mock is REFUSED in production unless explicitly allowed", async () => {
    // A synthetic price inside a document sent to a charterer is a fabricated
    // financial figure.
    const refused = await fetchEuaPrice(
      { CARBON_PRICE_PROVIDER: "mock", NODE_ENV: "production" },
      NOW
    );
    expect(refused.provenance.source).not.toBe("mock");

    const allowed = await fetchEuaPrice(
      {
        CARBON_PRICE_PROVIDER: "mock",
        NODE_ENV: "production",
        ALLOW_MOCK_CARBON_PRICE_IN_PRODUCTION: "1",
      },
      NOW
    );
    expect(allowed.provenance.source).toBe("mock");
  });

  test("no provider falls back to the documented static default, labelled as an assumption", async () => {
    const q = await fetchEuaPrice({}, NOW);
    expect(q.provenance.source).toBe("assumption");
    expect(q.provenance.label).toContain("Static default");
    expect(q.priceEur).toBe(staticEuaQuote().priceEur);
  });

  test("never throws — a labelled assumption beats no report at all", async () => {
    const q = await fetchEuaPrice(
      { CARBON_PRICE_PROVIDER: "broken", CARBON_PRICE_URL: "http://127.0.0.1:1/nope" },
      NOW
    );
    expect(isPlausibleEuaPrice(q.priceEur)).toBe(true);
    expect(q.provenance.unavailableReason).toContain("could not be reached");
  });

  test("every quote explains where it came from", async () => {
    for (const env of [{}, { CARBON_PRICE_PROVIDER: "mock" }, { ETS_EUA_PRICE_EUR: "80" }]) {
      const q = await fetchEuaPrice(env, NOW);
      expect(q.provenance.label.length).toBeGreaterThan(10);
    }
  });
});
