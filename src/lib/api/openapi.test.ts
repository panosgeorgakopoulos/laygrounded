import { describe, expect, test } from "bun:test";
import { buildOpenApiSpec } from "./openapi";
import { API_SCOPES } from "./keys";
import { TIME_BAR_EVENTS } from "./webhooks";
import { EVENT_TYPE_VALUES } from "@/lib/laytime/types";

const spec = buildOpenApiSpec("https://app.example.com") as any;

describe("buildOpenApiSpec", () => {
  test("is a well-formed OpenAPI 3.1 document", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.servers[0].url).toBe("https://app.example.com");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  test("every $ref resolves to a defined schema", () => {
    const refs: string[] = [];
    JSON.stringify(spec, (k, v) => {
      if (k === "$ref" && typeof v === "string") refs.push(v);
      return v;
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(spec.components.schemas[name]).toBeDefined();
    }
  });

  test("declares bearer auth and requires it globally", () => {
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  // The point of generating the spec instead of hand-writing YAML: it cannot
  // describe a scope, event or event type the code does not have.
  test("documents exactly the scopes the code enforces", () => {
    expect(Object.keys(spec["x-scopes"]).sort()).toEqual([...API_SCOPES].sort());
    for (const s of API_SCOPES) expect(spec["x-scopes"][s]).toBeTruthy();
  });

  test("documents exactly the webhook events the sweep can emit", () => {
    expect(spec.components.schemas.WebhookRegistration.properties.eventTypes.items.enum).toEqual([
      ...TIME_BAR_EVENTS,
    ]);
  });

  test("documents exactly the engine's event types", () => {
    expect(spec.components.schemas.SofEvent.properties.eventType.enum).toEqual([
      ...EVENT_TYPE_VALUES,
    ]);
  });

  test("every operation declares the scope it needs", () => {
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        expect(op.operationId, `${method} ${path} needs an operationId`).toBeTruthy();
        expect(op.security, `${method} ${path} needs security`).toBeDefined();
        const scopes: string[] = op.security[0].bearerAuth;
        for (const s of scopes) expect(API_SCOPES).toContain(s as (typeof API_SCOPES)[number]);
      }
    }
  });

  // The awkward truths an integrator would otherwise discover in production.
  test("states that pushed events are suggested and do not count", () => {
    expect(spec.info.description).toContain("suggested");
    expect(spec.info.description).toContain("do NOT contribute");
    expect(spec.components.schemas.VoyagePushResult.properties.eventStatus.enum).toEqual([
      "suggested",
    ]);
  });

  test("states the fixed-window burst edge rather than hiding it", () => {
    expect(spec.info.description).toContain("fixed clock minute");
    expect(spec.info.description).toContain("2×");
  });

  test("states that a null calculation is not zero demurrage", () => {
    expect(spec.paths["/api/v1/audit/voyages/{claimId}"].get.description).toContain("never 0");
  });

  // Regression: the spec declared 3.1.0 while using 3.0's `nullable`, which
  // JSON Schema 2020-12 removed. Caught by an external validator (redocly),
  // not by these tests — structure checks pass happily on a keyword the
  // version does not have. Generated clients would mis-handle precisely the
  // fields whose null carries meaning (calculation: null ≠ nothing owed).
  test("uses 3.1 type unions for nullability, never the 3.0 `nullable` keyword", () => {
    const found: string[] = [];
    JSON.stringify(spec, (k, v) => {
      if (k === "nullable") found.push(String(v));
      return v;
    });
    expect(found).toEqual([]);
    expect(spec.components.schemas.VoyageState.properties.calculation.type).toEqual(["object", "null"]);
    expect(spec.components.schemas.VoyageState.properties.timeBar.properties.deadline.type).toEqual([
      "string",
      "null",
    ]);
  });

  test("every operation documents a 4xx", () => {
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        const codes = Object.keys(op.responses);
        expect(
          codes.some((c) => c.startsWith("4")),
          `${method} ${path} documents no 4xx response`
        ).toBe(true);
      }
    }
  });

  test("serializes to JSON without cycles or undefined leaks", () => {
    const json = JSON.stringify(spec);
    expect(json).not.toContain("undefined");
    expect(JSON.parse(json).openapi).toBe("3.1.0");
  });
});
