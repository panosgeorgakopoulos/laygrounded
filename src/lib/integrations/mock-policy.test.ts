// Who may serve synthetic ERP data in production.
//
// The first block is the reason this module exists: a per-PROVIDER allowlist
// would have covered a live partner's integration, which is precisely the leak
// the allowlist is for.

import { describe, expect, test } from "bun:test";
import { evaluateMockPolicy, parseMockAllowlist, EMPTY_ALLOWLIST } from "./mock-policy";

const DEMO_INTEGRATION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PARTNER_INTEGRATION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const DEMO_COMPANY = "cccccccc-3333-4333-8333-cccccccccccc";
const PARTNER_COMPANY = "dddddddd-4444-4444-8444-dddddddddddd";

function verdict(raw: string | undefined, integrationId: string, companyId: string) {
  return evaluateMockPolicy({
    integrationId,
    companyId,
    nodeEnv: "production",
    allowlist: parseMockAllowlist(raw),
  });
}

describe("a live partner's integration cannot be reached by a demo entry", () => {
  test("allowlisting the demo integration does not cover the partner's", () => {
    // THE point of the module. If this ever passes for the partner, synthetic
    // voyages reach a real ERP.
    const allow = DEMO_INTEGRATION;
    expect(verdict(allow, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(true);
    expect(verdict(allow, PARTNER_INTEGRATION, PARTNER_COMPANY).allowed).toBe(false);
  });

  test("a company entry covers only that company", () => {
    const allow = `company:${DEMO_COMPANY}`;
    expect(verdict(allow, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(true);
    expect(verdict(allow, PARTNER_INTEGRATION, PARTNER_COMPANY).allowed).toBe(false);
  });

  test("a provider name is NOT a valid entry", () => {
    // The tempting spelling. "danaos" would have covered every Danaos
    // integration in the deployment, including a real partner's.
    const list = parseMockAllowlist("danaos,fortune");
    expect(list.integrationIds.size).toBe(0);
    expect(list.companyIds.size).toBe(0);
    expect(list.invalidEntries).toEqual(["danaos", "fortune"]);
    expect(verdict("danaos,fortune", PARTNER_INTEGRATION, PARTNER_COMPANY).allowed).toBe(false);
  });

  test("a partial id does not match by prefix", () => {
    // A typo'd or truncated id must fail closed, never widen.
    const truncated = DEMO_INTEGRATION.slice(0, 20);
    expect(verdict(truncated, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(false);
  });

  test("a company id in the integration position does not authorise the company", () => {
    // Positional confusion must not silently widen scope.
    expect(verdict(DEMO_COMPANY, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(false);
  });
});

describe("default posture", () => {
  test("nothing set means nothing may mock in production", () => {
    for (const raw of [undefined, "", "   ", ","]) {
      expect(verdict(raw, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(false);
    }
  });

  test("outside production the allowlist is irrelevant", () => {
    // Development and CI depend on fixtures working with no configuration.
    for (const env of ["development", "test", undefined]) {
      const v = evaluateMockPolicy({
        integrationId: PARTNER_INTEGRATION,
        companyId: PARTNER_COMPANY,
        nodeEnv: env,
        allowlist: EMPTY_ALLOWLIST,
      });
      expect(v).toEqual({ allowed: true, reason: "not_production" });
    }
  });

  test("the refusal names the id to add, so the error fixes itself", () => {
    const v = verdict(undefined, PARTNER_INTEGRATION, PARTNER_COMPANY);
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error("unreachable");
    expect(v.message).toContain(PARTNER_INTEGRATION);
    expect(v.message).toContain("ALLOWED_MOCK_INTEGRATIONS");
    expect(v.message).toContain("Do not allowlist a live partner");
  });
});

describe("parsing", () => {
  test("accepts comma, whitespace and newline separation", () => {
    const list = parseMockAllowlist(`${DEMO_INTEGRATION}, ${PARTNER_INTEGRATION}\n${DEMO_COMPANY}`);
    expect(list.integrationIds.size).toBe(3);
    expect(list.invalidEntries).toEqual([]);
  });

  test("UUIDs match case-insensitively", () => {
    // UUIDs are case-insensitive by specification; a copy-paste must still work.
    expect(verdict(DEMO_INTEGRATION.toUpperCase(), DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(true);
    expect(verdict(DEMO_INTEGRATION, DEMO_INTEGRATION.toUpperCase(), DEMO_COMPANY).allowed).toBe(true);
  });

  test("the company: prefix is case-insensitive", () => {
    expect(verdict(`COMPANY:${DEMO_COMPANY}`, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(true);
  });

  test("invalid entries are collected, not silently dropped", () => {
    // A misconfiguration must be reportable rather than quietly failing closed
    // with no explanation.
    const list = parseMockAllowlist(`${DEMO_INTEGRATION}, not-a-uuid, company:also-bad`);
    expect(list.integrationIds.has(DEMO_INTEGRATION)).toBe(true);
    expect(list.invalidEntries).toEqual(["not-a-uuid", "company:also-bad"]);
  });

  test("one bad entry does not invalidate the good ones", () => {
    expect(verdict(`garbage, ${DEMO_INTEGRATION}`, DEMO_INTEGRATION, DEMO_COMPANY).allowed).toBe(true);
  });

  test("reports which rule admitted the integration", () => {
    expect(verdict(DEMO_INTEGRATION, DEMO_INTEGRATION, DEMO_COMPANY)).toEqual({
      allowed: true,
      reason: "integration_allowlisted",
    });
    expect(verdict(`company:${DEMO_COMPANY}`, DEMO_INTEGRATION, DEMO_COMPANY)).toEqual({
      allowed: true,
      reason: "company_allowlisted",
    });
  });
});
