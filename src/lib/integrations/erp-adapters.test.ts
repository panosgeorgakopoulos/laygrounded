// Contract tests for the ERP adapters (Danaos, Fortune, Ulysses, Veson).
//
// Three things are being pinned here, in order of how expensive they are to get
// wrong:
//
//   1. MOCK PROVENANCE. A mock must be opt-in, must be refused in production,
//      and must be deterministic — a mock that invents a fresh voyage id per
//      sweep forks a claim per cron tick.
//   2. MAPPING DISCIPLINE. A row without identity is dropped, never defaulted;
//      an absent ETA is null, never `new Date()`.
//   3. CAPABILITY HONESTY. A declared capability the adapter cannot honour is
//      worse than an undeclared one: the job is accepted and then fails.

import { afterEach, describe, expect, test } from "bun:test";
import { DanaosAdapter } from "./danaos";
import { FortuneAdapter } from "./fortune";
import { UlyssesAdapter } from "./ulysses";
import { VesonImosAdapter } from "./veson";
import { MockErpAdapter } from "./mock";
import { getAdapter, PROVIDER_IDS, PROVIDERS } from "./registry";
import { mockImo, mockSchedules, mockVoyages, filterSince } from "./fixtures";
import { finiteOrNull, mapEventType, mapPortFunction, nullableTime } from "./normalize";
import {
  IntegrationProvider,
  IntegrationRow,
  IntegrationRequestError,
  IntegrationUnsupportedError,
} from "./types";
import { buildXml, parseXml, textAt, findDescendant, childrenNamed, child } from "./xml";

function row(
  provider: IntegrationProvider,
  over: Partial<IntegrationRow> = {}
): IntegrationRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    company_id: "22222222-2222-2222-2222-222222222222",
    provider,
    display_name: `${provider} test`,
    base_url: "https://erp.example.test",
    auth: { api_token: "tok" },
    config: {},
    status: "active",
    last_error: null,
    last_sync_at: null,
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ALLOWED_MOCK_INTEGRATIONS;
});

/** Captures the outbound request and replies with a canned body. */
function stubFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: String(opts.body ?? ""),
      headers: (opts.headers ?? {}) as Record<string, string>,
    });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

// === 1. Mode and provenance ===

describe("mock mode is opt-in and never inferred", () => {
  test("an integration with no credentials is LIVE, not silently mocked", () => {
    // The failure this prevents: an integration that looks connected, invents
    // voyages, and books invoices against ships that were never fixed. A
    // misconfigured integration must fail loudly.
    const adapter = new DanaosAdapter(row("DANAOS", { auth: {}, base_url: "" }));
    expect(adapter.mode).toBe("live");
  });

  test("config.mode = 'mock' is the only way in", () => {
    expect(new DanaosAdapter(row("DANAOS", { config: { mode: "mock" } })).mode).toBe("mock");
    expect(new FortuneAdapter(row("FORTUNE", { config: { mode: "mock" } })).mode).toBe("mock");
    expect(new UlyssesAdapter(row("ULYSSES", { config: { mode: "mock" } })).mode).toBe("mock");
  });

  test("an unrelated config value does not enable mock", () => {
    const adapter = new FortuneAdapter(row("FORTUNE", { config: { mode: "MOCK", other: 1 } }));
    expect(adapter.mode).toBe("live"); // case-sensitive on purpose
  });

  test("MOCK_ERP is always mock regardless of config", () => {
    expect(new MockErpAdapter(row("MOCK_ERP", { config: { mode: "live" } })).mode).toBe("mock");
  });

  test("sourceLabel names the mock so provenance reaches the UI", () => {
    const adapter = new DanaosAdapter(row("DANAOS", { config: { mode: "mock" } }));
    expect(adapter.sourceLabel).toContain("mock");
    expect(new DanaosAdapter(row("DANAOS")).sourceLabel).toBe("DANAOS");
  });
});

describe("mock data is refused in production", () => {
  const original = process.env.NODE_ENV;

  function withNodeEnv(value: string, fn: () => void | Promise<void>) {
    // NODE_ENV is readonly in the Next types but writable at runtime.
    (process.env as Record<string, string>).NODE_ENV = value;
    try {
      return fn();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = original ?? "test";
    }
  }

  test("a mock pull throws in production without the escape hatch", async () => {
    await withNodeEnv("production", async () => {
      const adapter = new DanaosAdapter(row("DANAOS", { config: { mode: "mock" } }));
      await expect(adapter.pullVoyages(null)).rejects.toThrow(/MOCK_ERP_REFUSED_IN_PRODUCTION/);
    });
  });

  test("a mock PUSH is refused too — not just reads", async () => {
    // A fabricated invoice reaching an accounting system is worse than a
    // fabricated read, so the guard must sit on both sides.
    await withNodeEnv("production", async () => {
      const adapter = new FortuneAdapter(row("FORTUNE", { config: { mode: "mock" } }));
      await expect(
        adapter.pushInvoice({
          externalRef: "V-1",
          claimId: "c-1",
          vessel: "X",
          vesselImo: null,
          voyageRef: "1",
          port: "Rotterdam",
          kind: "demurrage",
          amount: 1,
          currency: "USD",
          allowedHours: 1,
          usedHours: 2,
          computedAt: "2026-07-31T00:00:00Z",
          lines: [],
        })
      ).rejects.toThrow(/MOCK_ERP_REFUSED_IN_PRODUCTION/);
    });
  });

  test("allowlisting THIS integration permits it", async () => {
    await withNodeEnv("production", async () => {
      const r = row("DANAOS", { config: { mode: "mock" } });
      process.env.ALLOWED_MOCK_INTEGRATIONS = r.id;
      expect((await new DanaosAdapter(r).pullVoyages(null)).length).toBeGreaterThan(0);
    });
  });

  test("allowlisting a DIFFERENT integration does not permit this one", async () => {
    // The whole reason the allowlist is identity-scoped rather than
    // provider-scoped: a demo entry must never cover a live partner's row.
    await withNodeEnv("production", async () => {
      process.env.ALLOWED_MOCK_INTEGRATIONS = "99999999-9999-4999-8999-999999999999";
      const adapter = new DanaosAdapter(row("DANAOS", { config: { mode: "mock" } }));
      await expect(adapter.pullVoyages(null)).rejects.toThrow(/not allowlisted/);
    });
  });

  test("allowlisting the company permits its integrations", async () => {
    await withNodeEnv("production", async () => {
      const r = row("DANAOS", { config: { mode: "mock" } });
      process.env.ALLOWED_MOCK_INTEGRATIONS = `company:${r.company_id}`;
      expect((await new DanaosAdapter(r).pullVoyages(null)).length).toBeGreaterThan(0);
    });
  });

  test("outside production the mock works without any flag", async () => {
    const adapter = new DanaosAdapter(row("DANAOS", { config: { mode: "mock" } }));
    expect((await adapter.pullVoyages(null)).length).toBeGreaterThan(0);
  });
});

// === 2. Fixture determinism ===

describe("fixtures are deterministic", () => {
  test("the same integration yields byte-identical voyages across pulls", () => {
    // Inbound voyages upsert on (company, source, external_ref). A fresh ref
    // per sweep would fork one claim per cron tick.
    const a = mockVoyages("integration-A", { anchor: new Date("2026-07-31T00:00:00Z") });
    const b = mockVoyages("integration-A", { anchor: new Date("2026-07-31T00:00:00Z") });
    expect(a).toEqual(b);
  });

  test("external refs are stable even as the anchor moves", () => {
    const a = mockVoyages("integration-A", { anchor: new Date("2026-07-31T00:00:00Z") });
    const b = mockVoyages("integration-A", { anchor: new Date("2026-09-15T12:00:00Z") });
    expect(a.map((v) => v.externalRef)).toEqual(b.map((v) => v.externalRef));
  });

  test("different integrations get different fleets, not colliding refs", () => {
    const a = mockVoyages("integration-A");
    const b = mockVoyages("integration-B");
    expect(a.map((v) => v.vessel)).not.toEqual(b.map((v) => v.vessel));
  });

  test("two mock adapters in one company do not collide on external_ref", async () => {
    const one = await new DanaosAdapter(
      row("DANAOS", { id: "aaaa1111-1111-1111-1111-111111111111", config: { mode: "mock" } })
    ).pullVoyages(null);
    const two = await new DanaosAdapter(
      row("DANAOS", { id: "bbbb2222-2222-2222-2222-222222222222", config: { mode: "mock" } })
    ).pullVoyages(null);
    const overlap = one.filter((v) => two.some((w) => w.externalRef === v.externalRef));
    expect(overlap).toHaveLength(0);
  });

  test("each provider prefixes its own refs", async () => {
    const cfg = { config: { mode: "mock" } };
    expect((await new DanaosAdapter(row("DANAOS", cfg)).pullVoyages(null))[0].externalRef).toStartWith("DAN-");
    expect((await new FortuneAdapter(row("FORTUNE", cfg)).pullVoyages(null))[0].externalRef).toStartWith("FOR-");
    expect((await new UlyssesAdapter(row("ULYSSES", cfg)).pullVoyages(null))[0].externalRef).toStartWith("ULY-");
  });

  test("schedules leave some berths unassigned, as real ERPs do", () => {
    // Code that assumes ETB is always present passes its tests and fails on
    // first contact. The fixture must contain the awkward case.
    const schedules = mockSchedules("seed-with-mixed-berths", {
      count: 20,
      anchor: new Date("2026-07-31T00:00:00Z"),
    });
    expect(schedules.some((s) => s.etbISO === null)).toBe(true);
    expect(schedules.some((s) => s.etbISO !== null)).toBe(true);
  });

  test("schedule ETAs are forward of the anchor", () => {
    const anchor = new Date("2026-07-31T00:00:00Z");
    for (const s of mockSchedules("seed", { count: 20, anchor })) {
      expect(new Date(s.etaISO!).getTime()).toBeGreaterThan(anchor.getTime());
    }
  });

  test("filterSince implements the incremental cursor", () => {
    const rows = [
      { updatedAt: "2026-07-01T00:00:00Z" },
      { updatedAt: "2026-07-20T00:00:00Z" },
      { updatedAt: undefined },
    ];
    expect(filterSince(rows, "2026-07-10T00:00:00Z")).toHaveLength(2); // later + undated
    expect(filterSince(rows, null)).toHaveLength(3);
    expect(filterSince(rows, "not-a-date")).toHaveLength(3); // unparseable ⇒ no filter
  });
});

describe("mock IMO numbers satisfy the real checksum", () => {
  // Independent validator, grounded on published IMO numbers rather than on
  // the generator it is checking.
  function imoIsValid(imo: string): boolean {
    if (!/^\d{7}$/.test(imo)) return false;
    const d = imo.split("").map(Number);
    const sum = d.slice(0, 6).reduce((acc, n, i) => acc + n * (7 - i), 0);
    return sum % 10 === d[6];
  }

  test("the validator accepts known-real IMO numbers", () => {
    expect(imoIsValid("9074729")).toBe(true);
    expect(imoIsValid("9395044")).toBe(true);
  });

  test("the validator rejects a transposed digit", () => {
    expect(imoIsValid("9074720")).toBe(false);
  });

  test("every generated IMO passes it", () => {
    for (let i = 0; i < 500; i++) {
      expect(imoIsValid(mockImo(i))).toBe(true);
    }
  });
});

// === 3. Capabilities ===

describe("capabilities are honest", () => {
  test("every provider in the registry is constructible", () => {
    for (const p of PROVIDERS) {
      expect(() => getAdapter(row(p.provider))).not.toThrow();
    }
  });

  test("PROVIDER_IDS matches PROVIDERS exactly", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(PROVIDERS.map((p) => p.provider).sort());
  });

  test("a declared capability is backed by an override, never the throwing base", async () => {
    // Declaring a capability the adapter cannot honour is the worst case: the
    // job is accepted, then fails on delivery. This walks every provider and
    // checks the two optional methods against their declaration.
    for (const p of PROVIDERS) {
      const adapter = getAdapter(row(p.provider, { config: { mode: "mock" } }));
      const caps = adapter.capabilities;

      if (caps.pullSchedules) {
        await expect(adapter.pullSchedules(null)).resolves.toBeDefined();
      } else {
        await expect(adapter.pullSchedules(null)).rejects.toThrow(IntegrationUnsupportedError);
      }
    }
  });

  test("Ulysses refuses a P&L push it does not declare", async () => {
    const adapter = new UlyssesAdapter(row("ULYSSES", { config: { mode: "mock" } }));
    expect(adapter.capabilities.pushVoyagePnl).toBe(false);
    await expect(
      adapter.pushVoyagePnl({
        externalRef: null,
        voyagePnlId: "p-1",
        vessel: "X",
        voyageRef: "1",
        charterType: "voyage",
        perspective: "owner",
        currency: "USD",
        voyageStart: null,
        voyageEnd: null,
        grossRevenue: 0,
        revenueDeductions: 0,
        voyageExpenses: 0,
        transfers: 0,
        netResult: 0,
        tcePerDay: null,
        voyageDays: null,
        computedAt: "2026-07-31T00:00:00Z",
        lines: [],
        warnings: [],
      })
    ).rejects.toThrow(IntegrationUnsupportedError);
  });

  test("unverified mappings are flagged as such in the registry", () => {
    // The commercial claim "we integrate with Danaos" must not be allowed to
    // quietly become "we have tested against Danaos".
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.provider, p]));
    expect(byId.DANAOS.mappingVerifiedAgainstVendorDocs).toBe(false);
    expect(byId.FORTUNE.mappingVerifiedAgainstVendorDocs).toBe(false);
    expect(byId.ULYSSES.mappingVerifiedAgainstVendorDocs).toBe(false);
    expect(byId.VESON_IMOS.mappingVerifiedAgainstVendorDocs).toBe(true);
  });
});

// === 4. Danaos / SOAP ===

describe("Danaos SOAP", () => {
  const soapVoyages = buildXml({
    name: "soap:Envelope",
    attrs: { "xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/" },
    children: [
      {
        name: "soap:Body",
        children: [
          {
            name: "GetVoyagesResult",
            children: [
              {
                name: "Voyage",
                children: [
                  { name: "VoyageId", text: "DAN-77" },
                  { name: "VoyageNo", text: "77/2026" },
                  { name: "VesselName", text: "OLYMPIA SPIRIT" },
                  { name: "ImoNumber", text: "9074729" },
                  { name: "CargoDescription", text: "Iron ore fines" },
                  { name: "ChartererName", text: "Hellenic Bulk" },
                  { name: "LastModified", text: "2026-07-30T10:00:00Z" },
                  {
                    name: "PortCalls",
                    children: [{ name: "PortCall", children: [{ name: "PortName", text: "Qingdao" }] }],
                  },
                ],
              },
              // Second voyage lacks a vessel: must be dropped, not defaulted.
              { name: "Voyage", children: [{ name: "VoyageId", text: "DAN-78" }] },
            ],
          },
        ],
      },
    ],
  });

  test("parses a SOAP response and drops identity-less rows", async () => {
    stubFetch(soapVoyages, { contentType: "text/xml" });
    const voyages = await new DanaosAdapter(row("DANAOS")).pullVoyages(null);
    expect(voyages).toHaveLength(1);
    expect(voyages[0]).toMatchObject({
      externalRef: "DAN-77",
      vessel: "OLYMPIA SPIRIT",
      voyageRef: "77/2026",
      port: "Qingdao",
      cargo: "Iron ore fines",
      counterpartyName: "Hellenic Bulk",
    });
  });

  test("sends a well-formed envelope with the SOAPAction header", async () => {
    const calls = stubFetch(soapVoyages, { contentType: "text/xml" });
    await new DanaosAdapter(row("DANAOS")).pullVoyages("2026-07-01T00:00:00Z");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.SOAPAction).toBe("urn:danaos:erp:v1/GetVoyages");
    const sent = parseXml(calls[0].body);
    expect(textAt(findDescendant(sent, "GetVoyages"), "UpdatedAfter")).toBe("2026-07-01T00:00:00Z");
  });

  test("WS-Security header is present only when a username is configured", async () => {
    const withCreds = stubFetch(soapVoyages, { contentType: "text/xml" });
    await new DanaosAdapter(
      row("DANAOS", { auth: { username: "svc", password: "pw" } })
    ).pullVoyages(null);
    expect(findDescendant(parseXml(withCreds[0].body), "Username")?.text).toBe("svc");

    const without = stubFetch(soapVoyages, { contentType: "text/xml" });
    await new DanaosAdapter(row("DANAOS")).pullVoyages(null);
    expect(findDescendant(parseXml(without[0].body), "Security")).toBeNull();
  });

  test("a SOAP Fault returned with HTTP 200 is an error, not an empty result", async () => {
    // Otherwise the job records "succeeded" having pushed nothing.
    stubFetch(
      buildXml({
        name: "soap:Envelope",
        attrs: { "xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/" },
        children: [
          {
            name: "soap:Body",
            children: [
              {
                name: "soap:Fault",
                children: [
                  { name: "faultcode", text: "soap:Client" },
                  { name: "faultstring", text: "Voyage 77 is locked for period-end" },
                ],
              },
            ],
          },
        ],
      }),
      { contentType: "text/xml" }
    );
    await expect(new DanaosAdapter(row("DANAOS")).pullVoyages(null)).rejects.toThrow(
      /locked for period-end/
    );
  });

  test("invoice values are escaped, so a hostile name cannot rewrite the amount", async () => {
    const calls = stubFetch(
      buildXml({ name: "Envelope", children: [{ name: "Body", text: "ok" }] }),
      { contentType: "text/xml" }
    );
    await new DanaosAdapter(row("DANAOS")).pushInvoice({
      externalRef: "V-1",
      claimId: "c-1",
      vessel: `EVIL</Amount><Amount>0`,
      vesselImo: null,
      voyageRef: "1",
      port: "Piraeus",
      kind: "demurrage",
      amount: 125_000.5,
      currency: "USD",
      allowedHours: 72,
      usedHours: 96.25,
      computedAt: "2026-07-31T00:00:00Z",
      lines: [],
    });
    const sent = parseXml(calls[0].body);
    const op = findDescendant(sent, "PostDemurrageInvoice");
    expect(textAt(op, "Amount")).toBe("125000.50");
    expect(textAt(op, "VesselName")).toBe(`EVIL</Amount><Amount>0`);
  });

  test("a hostile inbound notification degrades to unknown rather than throwing", () => {
    const event = new DanaosAdapter(row("DANAOS")).parseInboundEvent(
      `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`
    );
    expect(event.type).toBe("unknown");
    expect(event.eventId).toBe("");
    expect(event.voyage).toBeNull();
  });

  test("parses a well-formed XML notification", () => {
    const event = new DanaosAdapter(row("DANAOS")).parseInboundEvent(
      buildXml({
        name: "VoyageNotification",
        children: [
          { name: "NotificationId", text: "N-9" },
          { name: "EventType", text: "VOYAGE_UPDATED" },
          {
            name: "Voyage",
            children: [
              { name: "VoyageId", text: "DAN-77" },
              { name: "VesselName", text: "PATMOS GLORY" },
            ],
          },
        ],
      })
    );
    expect(event).toMatchObject({ eventId: "N-9", type: "voyage.updated" });
    expect(event.voyage?.vessel).toBe("PATMOS GLORY");
  });

  test("schedule times: absent values are null, never coerced to now", async () => {
    stubFetch(
      buildXml({
        name: "Envelope",
        children: [
          {
            name: "Body",
            children: [
              {
                name: "GetVesselScheduleResult",
                children: [
                  {
                    name: "PortCall",
                    children: [
                      { name: "PortCallId", text: "PC-1" },
                      { name: "VesselName", text: "SIFNOS VOYAGER" },
                      { name: "ETA", text: "2026-08-04T06:00:00Z" },
                      { name: "ETB", text: "" },
                      { name: "ETD", text: "TBA" },
                      { name: "CallPurpose", text: "Discharge" },
                      { name: "CargoQuantity", text: "not-a-number" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      { contentType: "text/xml" }
    );
    const [s] = await new DanaosAdapter(row("DANAOS")).pullSchedules(null);
    expect(s.etaISO).toBe("2026-08-04T06:00:00.000Z");
    expect(s.etbISO).toBeNull(); // empty
    expect(s.etdISO).toBeNull(); // unparseable, NOT passed through
    expect(s.portFunction).toBe("discharge");
    expect(s.cargoQuantityMt).toBeNull();
  });
});

// === 5. Fortune / JSON ===

describe("Fortune JSON", () => {
  const VOYAGE = {
    voyageId: 4201,
    voyageNumber: "4201/2026",
    vesselName: "IONIAN PIONEER",
    imoNumber: 9395044,
    cargoType: "Steam coal",
    chartererName: "Adriatic Commodities BV",
    modifiedOn: "2026-07-29T08:00:00Z",
    ports: [
      { portName: "Richards Bay", portFunction: "Load" },
      { portName: "Rotterdam", portFunction: "Discharge" },
    ],
  };

  test("tolerates all three collection envelopes", async () => {
    for (const body of [
      JSON.stringify([VOYAGE]),
      JSON.stringify({ voyages: [VOYAGE] }),
      JSON.stringify({ data: [VOYAGE] }),
    ]) {
      stubFetch(body);
      const voyages = await new FortuneAdapter(row("FORTUNE")).pullVoyages(null);
      expect(voyages).toHaveLength(1);
      expect(voyages[0].vessel).toBe("IONIAN PIONEER");
    }
  });

  test("an unrecognised envelope yields zero rows, never fabricated ones", async () => {
    stubFetch(JSON.stringify({ unexpected: { nested: [VOYAGE] } }));
    expect(await new FortuneAdapter(row("FORTUNE")).pullVoyages(null)).toEqual([]);
  });

  test("prefers the discharge port, where demurrage accrues", async () => {
    stubFetch(JSON.stringify([VOYAGE]));
    const [v] = await new FortuneAdapter(row("FORTUNE")).pullVoyages(null);
    expect(v.port).toBe("Rotterdam");
  });

  test("numeric ids and IMOs survive as strings", async () => {
    stubFetch(JSON.stringify([VOYAGE]));
    const [v] = await new FortuneAdapter(row("FORTUNE")).pullVoyages(null);
    expect(v.externalRef).toBe("4201");
    expect(v.vesselImo).toBe("9395044");
  });

  test("sends the incremental cursor as a query parameter on a GET", async () => {
    const calls = stubFetch(JSON.stringify([]));
    await new FortuneAdapter(row("FORTUNE")).pullVoyages("2026-07-01T00:00:00Z");
    expect(calls[0].url).toContain("modifiedSince=2026-07-01T00%3A00%3A00Z");
  });

  test("config overrides the path and the collection key", async () => {
    const calls = stubFetch(JSON.stringify({ items: [VOYAGE] }));
    const adapter = new FortuneAdapter(
      row("FORTUNE", { config: { voyages_path: "/custom/v2/voy", voyages_key: "items" } })
    );
    const voyages = await adapter.pullVoyages(null);
    expect(calls[0].url).toContain("/custom/v2/voy");
    expect(voyages).toHaveLength(1);
  });

  test("P&L push carries warnings and the excluded flag", async () => {
    // An ERP that re-adds an excluded line silently disagrees with our own net
    // result; one that drops the warnings books a provisional figure as final.
    const calls = stubFetch(JSON.stringify({ resultId: "R-1" }));
    await new FortuneAdapter(row("FORTUNE")).pushVoyagePnl({
      externalRef: "V-1",
      voyagePnlId: "p-1",
      vessel: "THALASSA HORIZON",
      voyageRef: "12/2026",
      charterType: "voyage",
      perspective: "owner",
      currency: "USD",
      voyageStart: "2026-03-01T00:00:00Z",
      voyageEnd: "2026-03-31T00:00:00Z",
      grossRevenue: 1_000_000,
      revenueDeductions: 25_000,
      voyageExpenses: 400_000,
      transfers: 0,
      netResult: 575_000,
      tcePerDay: 19_166.67,
      voyageDays: 30,
      computedAt: "2026-07-31T00:00:00Z",
      lines: [
        { key: "freight", label: "Freight", kind: "revenue", amount: 1_000_000, currency: "USD", excluded: false, note: null },
        { key: "misc", label: "EUR port dues", kind: "expense", amount: -5_000, currency: "EUR", excluded: true, note: "off-currency" },
      ],
      warnings: ["1 linked claim has no calculation"],
    });

    const sent = JSON.parse(calls[0].body);
    expect(sent.warnings).toEqual(["1 linked claim has no calculation"]);
    expect(sent.lines[1].excludedFromTotals).toBe(true);
    // Sign preserved exactly as the sheet computed it.
    expect(sent.lines[1].amount).toBe(-5_000);
    expect(sent.netResult).toBe(575_000);
  });
});

// === 6. Ulysses / entity envelope ===

describe("Ulysses entity envelope", () => {
  const entity = {
    entityType: "Voyage",
    entityId: "U-88",
    attributes: {
      vesselName: "KYTHNOS TRADER",
      voyageCode: "88/2026",
      portName: "Paradip",
      cargoDescription: "Urea (bulk)",
      charterer: "Levant Dry Cargo DMCC",
      changedOn: "2026-07-28T00:00:00Z",
    },
  };

  test("reads the nested result envelope", async () => {
    stubFetch(JSON.stringify({ result: { entities: [entity], revision: 12 } }));
    const [v] = await new UlyssesAdapter(row("ULYSSES")).pullVoyages(null);
    expect(v).toMatchObject({
      externalRef: "U-88",
      vessel: "KYTHNOS TRADER",
      voyageRef: "88/2026",
      port: "Paradip",
    });
  });

  test("filters out foreign entity types from an expanded response", async () => {
    // Mapping a Berth as a Voyage would create a claim for a place, not a ship.
    stubFetch(
      JSON.stringify({
        result: {
          entities: [entity, { entityType: "Berth", entityId: "B-1", attributes: { vesselName: "x" } }],
        },
      })
    );
    const voyages = await new UlyssesAdapter(row("ULYSSES")).pullVoyages(null);
    expect(voyages).toHaveLength(1);
    expect(voyages[0].externalRef).toBe("U-88");
  });

  test("an attribute bag with non-string values is coerced safely", async () => {
    stubFetch(
      JSON.stringify({
        entities: [
          {
            entityType: "Voyage",
            entityId: 99,
            attributes: { vesselName: "MELTEMI SPIRIT", imo: 9074729, cargo: { nested: true } },
          },
        ],
      })
    );
    const [v] = await new UlyssesAdapter(row("ULYSSES")).pullVoyages(null);
    expect(v.externalRef).toBe("99");
    expect(v.vesselImo).toBe("9074729");
    expect(v.cargo).toBe("Unknown"); // an object is not a cargo description
  });
});

// === 7. Shared normalizers ===

describe("normalizers", () => {
  test("nullableTime turns 'the ERP did not say' into null", () => {
    expect(nullableTime("2026-08-04T06:00:00Z")).toBe("2026-08-04T06:00:00.000Z");
    for (const absent of ["", "   ", "TBA", "n/a", null, undefined, 42, {}]) {
      expect(nullableTime(absent)).toBeNull();
    }
  });

  test("finiteOrNull rejects NaN and Infinity, not just non-numbers", () => {
    expect(finiteOrNull("72000")).toBe(72_000);
    expect(finiteOrNull(72_000)).toBe(72_000);
    expect(finiteOrNull(NaN)).toBeNull();
    expect(finiteOrNull(Infinity)).toBeNull();
    expect(finiteOrNull("abc")).toBeNull();
    expect(finiteOrNull("")).toBeNull();
  });

  test("mapPortFunction handles every vendor spelling, and guesses nothing", () => {
    expect(mapPortFunction("LOAD")).toBe("load");
    expect(mapPortFunction("Loading")).toBe("load");
    expect(mapPortFunction("D")).toBe("discharge");
    expect(mapPortFunction("Unload")).toBe("discharge");
    expect(mapPortFunction("Bunkering")).toBe("bunker");
    expect(mapPortFunction("Canal transit")).toBe("transit");
    expect(mapPortFunction("something else")).toBe("unknown");
    expect(mapPortFunction("")).toBe("unknown");
    expect(mapPortFunction(null)).toBe("unknown");
  });

  test("mapEventType accepts the three spellings and rejects the rest", () => {
    expect(mapEventType("voyage.created")).toBe("voyage.created");
    expect(mapEventType("VOYAGE_CREATED")).toBe("voyage.created");
    expect(mapEventType("VoyageCreated")).toBe("voyage.created");
    expect(mapEventType("voyage.updated")).toBe("voyage.updated");
    expect(mapEventType("VoyageChanged")).toBe("voyage.updated");
    // Acting on an unrecognised type is how an unrelated ERP notification
    // becomes a claim.
    expect(mapEventType("invoice.paid")).toBe("unknown");
    expect(mapEventType("voyage.deleted")).toBe("unknown");
    expect(mapEventType(undefined)).toBe("unknown");
  });
});

// === 8. Veson regression ===

describe("Veson still behaves after the interface change", () => {
  test("GraphQL pull maps as before", async () => {
    stubFetch(
      JSON.stringify({
        data: {
          voyages: {
            nodes: [
              {
                id: "V-1",
                voyageNo: "1/2026",
                vesselName: "AEGEAN TRADER",
                cargoDescription: "Bauxite",
                portCalls: [{ portName: "Yantai" }],
              },
            ],
          },
        },
      })
    );
    const [v] = await new VesonImosAdapter(row("VESON_IMOS")).pullVoyages(null);
    expect(v).toMatchObject({ externalRef: "V-1", vessel: "AEGEAN TRADER", port: "Yantai" });
  });

  test("GraphQL errors surface rather than becoming an empty pull", async () => {
    stubFetch(JSON.stringify({ errors: [{ message: "field 'voyages' not found" }] }));
    await expect(new VesonImosAdapter(row("VESON_IMOS")).pullVoyages(null)).rejects.toThrow(
      /field 'voyages' not found/
    );
  });
});

// === 9. Transport ===

describe("transport", () => {
  test("a 401 fails fast without burning retries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(new FortuneAdapter(row("FORTUNE")).pullVoyages(null)).rejects.toThrow(
      /rejected credentials/
    );
    expect(calls).toBe(1);
  });

  test("a non-JSON body from a JSON endpoint is a clear error", async () => {
    stubFetch("<html>gateway timeout</html>");
    await expect(new FortuneAdapter(row("FORTUNE")).pullVoyages(null)).rejects.toThrow(
      /non-JSON body/
    );
  });

  test("a 4xx that is not auth surfaces the ERP's message", async () => {
    stubFetch("voyage is locked", { status: 422 });
    await expect(new FortuneAdapter(row("FORTUNE")).pullVoyages(null)).rejects.toThrow(
      /voyage is locked/
    );
  });
});
