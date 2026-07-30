// OpenAPI 3.1 description of the LayGrounded public API.
//
// Built in code from the same constants the routes enforce (API_SCOPES,
// TIME_BAR_EVENTS, EVENT_TYPE_VALUES) rather than hand-written as YAML. A
// static spec drifts from the implementation the first time a scope is added
// and nobody notices; deriving it means the document cannot describe a scope
// that does not exist.
//
// The descriptions state the awkward truths deliberately — that pushed events
// are 'suggested' and do not count, that the rate limit window is fixed and
// can be burst across a boundary — because an integrator who learns those in
// production learns them the expensive way.

import { API_SCOPES } from "./keys";
import { TIME_BAR_EVENTS } from "./webhooks";
import { EVENT_TYPE_VALUES } from "@/lib/laytime/types";

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "voyages:write": "Push voyage and Statement of Facts data into LayGrounded.",
  "calculations:read": "Read laytime calculations, time-bar status and voyage metadata.",
  "calculations:write": "Trigger a laytime recalculation from confirmed events.",
  "disputes:read": "Read counterparty proposals and clause flags for a voyage.",
  "pnl:read": "Read voyage P&L results, including TCE.",
  "documents:read": "Read evidence dossiers, notarization records and exports.",
  "compliance:read": "Read MRV reports, emissions estimates and compliance screening results.",
  "webhooks:manage": "Register, list and remove webhook subscriptions.",
};

const claimIdParam = {
  name: "claimId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "LayGrounded API",
      version: "1.0.0",
      description: [
        "Integration surface for laytime, demurrage and voyage commercial management.",
        "",
        "## Authentication",
        "Every endpoint takes an API key as `Authorization: Bearer <key>`. Keys are issued",
        "in the LayGrounded app (they cannot be minted through this API — a leaked key must",
        "not be able to mint more). Only a hash is stored: a key is shown once, at creation.",
        "",
        "Most endpoints are dual-authenticated: the same route serves the web app over a",
        "session cookie and integrators over an API key. Presenting an `Authorization`",
        "header selects the API-key path outright — a rejected key never falls back to a",
        "session, so a key tested from inside a logged-in browser fails as it should",
        "rather than silently succeeding with the user's own privileges.",
        "",
        "## Scopes",
        "Keys carry explicit scopes and are granted nothing by default. A request outside a",
        "key's scope returns 403 `INSUFFICIENT_SCOPE` naming the scope required.",
        "",
        "## Rate limiting",
        "Quotas are per API key (not per IP — an ERP behind NAT is one IP for many tenants),",
        "counted in a shared store so the limit holds across server instances. The window is",
        "a fixed clock minute: a client can therefore burst up to 2× its quota across a",
        "boundary. Every response carries `X-RateLimit-Limit` and `X-RateLimit-Reset`; a 429",
        "carries `Retry-After`. If the limiter itself is unavailable, requests are refused",
        "(429 `RATE_LIMIT_UNAVAILABLE`) rather than waved through unmetered.",
        "",
        "## A note on pushed events",
        "Events you push are recorded with status `suggested`. They do NOT contribute to the",
        "laytime calculation, the time bar, or notarized proofs until a human confirms them",
        "in the workspace. This is deliberate: confirmed events are legal evidence, and",
        "arriving over an API is not review. Poll the voyage endpoint to see when a",
        "calculation appears.",
      ].join("\n"),
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Voyages", description: "Push voyage data in; pull calculations and dispute status." },
      { name: "Webhooks", description: "Time-bar deadline alerts." },
      { name: "Calculations", description: "Trigger and audit laytime calculations." },
      { name: "Voyage P&L", description: "Freight, hire, costs and TCE for a whole voyage." },
      { name: "Documents", description: "Evidence dossiers and notarization records." },
      { name: "Disputes", description: "Counterparty proposals, negotiation state, charter chains." },
      { name: "Analysis", description: "Pre-fixture intelligence and speed optimisation." },
      { name: "Compliance", description: "EU MRV reporting." },
    ],
    paths: {
      "/api/v1/voyages": {
        post: {
          tags: ["Voyages"],
          summary: "Push a voyage",
          description:
            "Idempotent on `externalRef`: pushing the same reference twice updates one voyage rather than creating two. Events land as `suggested` (see the note above).",
          operationId: "pushVoyage",
          security: [{ bearerAuth: ["voyages:write"] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/VoyagePush" } } },
          },
          responses: {
            "201": { description: "Voyage created.", content: jsonSchemaRef("VoyagePushResult") },
            "200": { description: "Existing voyage updated.", content: jsonSchemaRef("VoyagePushResult") },
            "400": errorResponse("Validation failed."),
            "401": errorResponse("Missing or invalid API key."),
            "403": errorResponse("Key lacks the voyages:write scope."),
            "429": errorResponse("Rate limit exceeded."),
          },
        },
        get: {
          tags: ["Voyages"],
          summary: "List voyages",
          operationId: "listVoyages",
          security: [{ bearerAuth: ["calculations:read"] }],
          parameters: [
            {
              name: "externalRef",
              in: "query",
              schema: { type: "string" },
              description: "Resolve your own reference to a LayGrounded claim id.",
            },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          ],
          responses: {
            "200": { description: "Voyage list." },
            "401": errorResponse("Missing or invalid API key."),
            "429": errorResponse("Rate limit exceeded."),
          },
        },
      },
      "/api/v1/voyages/{claimId}": {
        get: {
          tags: ["Voyages"],
          summary: "Pull a voyage's calculation, dispute status and time bar",
          description:
            "`calculation` is null until the voyage's events are confirmed and computed — never 0, which would read as 'no demurrage due'. Dispute detail requires the `disputes:read` scope; without it the `disputes` object reports `withheld: true` rather than being silently omitted.",
          operationId: "getVoyage",
          security: [{ bearerAuth: ["calculations:read"] }],
          parameters: [
            { name: "claimId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Voyage state.", content: jsonSchemaRef("VoyageState") },
            "401": errorResponse("Missing or invalid API key."),
            "404": errorResponse("No voyage with that id for this key."),
            "429": errorResponse("Rate limit exceeded."),
          },
        },
      },
      "/api/v1/webhooks": {
        post: {
          tags: ["Webhooks"],
          summary: "Register a time-bar alert webhook",
          description: [
            "Deliveries are signed: `x-laygrounded-signature: sha256=HMAC-SHA256(raw body, secret)`.",
            "Verify it against the raw body before trusting a payload.",
            "",
            "The secret is returned once, here.",
            "",
            "Alerts fire at most once per crossing — a claim entering `warning` alerts once,",
            "not once per sweep. If the deadline itself moves (the voyage's events changed),",
            "that is a new crossing and alerts again.",
            "",
            "URLs must be https and must not resolve to private or loopback addresses.",
          ].join("\n"),
          operationId: "registerWebhook",
          security: [{ bearerAuth: ["webhooks:manage"] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookRegistration" } } },
          },
          responses: {
            "201": { description: "Registered; includes the signing secret (shown once)." },
            "400": errorResponse("Validation failed, or the URL is not https / is private."),
            "401": errorResponse("Missing or invalid API key."),
            "403": errorResponse("Key lacks the webhooks:manage scope."),
          },
        },
        get: {
          tags: ["Webhooks"],
          summary: "List webhook registrations",
          operationId: "listWebhooks",
          security: [{ bearerAuth: ["webhooks:manage"] }],
          responses: {
            "200": { description: "Registrations (secrets are never returned)." },
            "401": errorResponse("Missing or invalid API key."),
            "403": errorResponse("Key lacks the webhooks:manage scope."),
          },
        },
      },
      "/api/v1/webhooks/{webhookId}": {
        delete: {
          tags: ["Webhooks"],
          summary: "Remove a webhook registration",
          operationId: "deleteWebhook",
          security: [{ bearerAuth: ["webhooks:manage"] }],
          parameters: [
            { name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "Deleted." },
            "404": errorResponse("No webhook with that id for this key."),
          },
        },
      },

      // === Calculations ===
      "/api/v1/claims/{claimId}/calculate": {
        post: {
          tags: ["Calculations"],
          summary: "Trigger a laytime recalculation",
          operationId: "calculateClaim",
          description: [
            "Recomputes from CONFIRMED events only and returns the totals, the hour-by-hour",
            "breakdown and the time-bar position.",
            "",
            "Events pushed through this API are recorded as `suggested` and do not count until",
            "a human confirms them, so pushing and immediately calculating will correctly show",
            "no change. That is deliberate: an API push must not move a legally-operative",
            "figure without review.",
            "",
            "422 is returned for inputs the engine refuses — `NO_NOR` (no Notice of Readiness),",
            "`MULTIPLE_NOR`, `INVALID_CP_TERMS`, `CALCULATION_TIMEOUT` (voyage longer than the",
            "engine's 60-day iteration ceiling).",
          ].join("\n"),
          security: [{ bearerAuth: ["calculations:write"] }],
          parameters: [claimIdParam],
          responses: {
            "200": { description: "Recalculated." },
            "404": errorResponse("No claim with that id for this key's company."),
            "422": errorResponse("The engine refused these inputs; the code names why."),
          },
        },
      },

      // === Voyage P&L ===
      "/api/v1/voyage-pnl/{pnlId}": {
        get: {
          tags: ["Voyage P&L"],
          summary: "Read a voyage P&L, including TCE",
          operationId: "getVoyagePnl",
          description: [
            "Freight or hire, commissions, engine-fed demurrage and despatch, bunkers, port",
            "costs, and the Time Charter Equivalent.",
            "",
            "Recomputed on read rather than served from the last stored snapshot: a linked",
            "claim's calculation can change after a snapshot was taken.",
            "",
            "`warnings` is part of the contract, not decoration. It names linked claims with",
            "no calculation yet and lines excluded for being in another currency. A caller",
            "that ignores it can book an incomplete result as final.",
            "",
            "`tce.perDay` is null when the voyage has no start and end date. Bunkers on",
            "delivery/redelivery appear as `transfer` lines and are deliberately EXCLUDED",
            "from TCE — they are cash moving between the parties, not something the voyage",
            "earned or consumed.",
          ].join("\n"),
          security: [{ bearerAuth: ["pnl:read"] }],
          parameters: [
            { name: "pnlId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": { description: "The computed sheet." },
            "404": errorResponse("No voyage P&L with that id for this key's company."),
            "422": errorResponse("The stored terms no longer validate."),
          },
        },
      },

      // === Documents & evidence ===
      "/api/v1/claims/{claimId}/dossier": {
        get: {
          tags: ["Documents"],
          summary: "Export the evidence dossier",
          operationId: "getDossier",
          description:
            "The claim's proven state at an instant. `?asOf=<ISO>` returns the proof in force " +
            "at that time; omit it for the current proof. `?format=markdown` returns the " +
            "dossier document instead of JSON.",
          security: [{ bearerAuth: ["documents:read"] }],
          parameters: [
            claimIdParam,
            { name: "asOf", in: "query", required: false, schema: { type: "string", format: "date-time" } },
            { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "markdown"] } },
          ],
          responses: {
            "200": { description: "The dossier." },
            "404": errorResponse("No claim with that id for this key's company."),
          },
        },
      },
      "/api/v1/claims/{claimId}/notarize": {
        get: {
          tags: ["Documents"],
          summary: "Read the notarization record",
          operationId: "getNotarization",
          description:
            "The RFC-3161 timestamp anchors recorded for this claim. Creating an anchor is " +
            "session-only — notarization is a legal act and is not delegated to a key.",
          security: [{ bearerAuth: ["documents:read"] }],
          parameters: [claimIdParam],
          responses: {
            "200": { description: "Anchors on record." },
            "404": errorResponse("No claim with that id for this key's company."),
          },
        },
      },

      // === Disputes ===
      "/api/v1/claims/{claimId}/negotiate": {
        get: {
          tags: ["Disputes"],
          summary: "Read autonomous negotiation state",
          operationId: "getNegotiation",
          description:
            "Settlement matrices produced by the deterministic negotiation agents. Running a " +
            "negotiation is session-only: its output is gated on human approval before it " +
            "can settle anything.",
          security: [{ bearerAuth: ["disputes:read"] }],
          parameters: [claimIdParam],
          responses: {
            "200": { description: "Negotiation state." },
            "404": errorResponse("No claim with that id for this key's company."),
          },
        },
      },
      "/api/v1/claims/{claimId}/ripple": {
        get: {
          tags: ["Disputes"],
          summary: "Read the charter chain for a claim",
          operationId: "getCharterChain",
          security: [{ bearerAuth: ["disputes:read"] }],
          parameters: [claimIdParam],
          responses: {
            "200": { description: "Parent and sub-claims." },
            "404": errorResponse("No claim with that id for this key's company."),
          },
        },
      },
      "/api/v1/claims/{claimId}/geofence-audit": {
        post: {
          tags: ["Calculations"],
          summary: "Audit SoF events against an AIS track",
          operationId: "geofenceAudit",
          description:
            "Cross-checks recorded events against vessel positions. Supply a track in the " +
            "body, or omit it to use the configured AIS provider. Reports `unavailable` " +
            "rather than guessing when no track can be obtained.",
          security: [{ bearerAuth: ["calculations:read"] }],
          parameters: [claimIdParam],
          responses: {
            "200": { description: "Audit result." },
            "404": errorResponse("No claim with that id for this key's company."),
          },
        },
      },

      // === Ingestion ===
      "/api/v1/ingestion/sof-text": {
        post: {
          tags: ["Voyages"],
          summary: "Ingest a Statement of Facts as text",
          operationId: "ingestSofText",
          description:
            "Extracts timeline events from pasted or emailed SoF text. Extracted events land " +
            "as `suggested` and do not count until confirmed.",
          security: [{ bearerAuth: ["voyages:write"] }],
          responses: {
            "200": { description: "Events extracted." },
            "422": errorResponse("No usable events could be extracted."),
          },
        },
      },

      // === Analysis ===
      "/api/v1/intel/prefixture": {
        post: {
          tags: ["Analysis"],
          summary: "Pre-fixture clause and route intelligence",
          operationId: "prefixtureIntel",
          description:
            "Historical exposure for a route and clause set. Returns `INSUFFICIENT_DATA` " +
            "rather than an estimate when the sample is too thin to be meaningful.",
          security: [{ bearerAuth: ["calculations:read"] }],
          responses: {
            "200": { description: "Intelligence for the route." },
            "422": errorResponse("Not enough historical voyages for this route."),
          },
        },
      },
      "/api/v1/optimization/ecospeed": {
        post: {
          tags: ["Analysis"],
          summary: "Optimal speed recommendation",
          operationId: "ecoSpeed",
          description:
            "Weighs extra bunker burn against expected demurrage to recommend a speed. " +
            "Read-only: it computes a recommendation and changes nothing.",
          security: [{ bearerAuth: ["calculations:read"] }],
          responses: {
            "200": { description: "Recommendation." },
            "422": errorResponse("Insufficient telemetry to recommend a speed."),
          },
        },
      },

      // === Compliance ===
      "/api/v1/compliance/mrv-report": {
        post: {
          tags: ["Compliance"],
          summary: "Generate a sealed EU MRV report",
          operationId: "generateMrvReport",
          description:
            "Builds and Merkle-seals an annual MRV report for the company. The seal is what " +
            "makes the report verifiable by a regulator without trusting LayGrounded.",
          security: [{ bearerAuth: ["compliance:read"] }],
          responses: {
            "200": { description: "Report and seal." },
            "422": errorResponse("Not enough voyage data for the reporting period."),
          },
        },
        get: {
          tags: ["Compliance"],
          summary: "List sealed MRV reports",
          operationId: "listMrvReports",
          security: [{ bearerAuth: ["compliance:read"] }],
          responses: {
            "200": { description: "Reports on record." },
            "401": errorResponse("Missing or invalid API key."),
            "403": errorResponse("Key lacks the compliance:read scope."),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: `API key issued in the LayGrounded app. Scopes: ${API_SCOPES.join(", ")}.`,
        },
      },
      schemas: {
        VoyagePush: {
          type: "object",
          required: ["externalRef", "vessel", "voyageRef", "port", "cargo"],
          properties: {
            externalRef: {
              type: "string",
              maxLength: 200,
              description: "Your identifier for this voyage. Doubles as the idempotency key.",
            },
            vessel: { type: "string", maxLength: 120 },
            vesselImo: { type: "string", maxLength: 20 },
            voyageRef: { type: "string", maxLength: 120 },
            port: { type: "string", maxLength: 120 },
            cargo: { type: "string", maxLength: 200 },
            counterpartyName: { type: "string", maxLength: 200 },
            timeBarDays: { type: "integer", minimum: 1, maximum: 3650, default: 90 },
            events: { type: "array", maxItems: 500, items: { $ref: "#/components/schemas/SofEvent" } },
          },
        },
        SofEvent: {
          type: "object",
          required: ["eventType", "occurredAt"],
          properties: {
            eventType: { type: "string", enum: [...EVENT_TYPE_VALUES] },
            occurredAt: {
              type: "string",
              format: "date-time",
              description:
                "ISO 8601 with an explicit UTC offset. Timestamps without one are rejected: a naive time read in the wrong zone silently moves money.",
            },
            rawText: { type: "string", maxLength: 500 },
          },
        },
        VoyagePushResult: {
          type: "object",
          properties: {
            claimId: { type: "string", format: "uuid" },
            externalRef: { type: "string" },
            created: { type: "boolean" },
            eventsInserted: { type: "integer" },
            eventStatus: { type: "string", enum: ["suggested"] },
            notice: { type: "string" },
          },
        },
        VoyageState: {
          type: "object",
          properties: {
            claimId: { type: "string", format: "uuid" },
            // OpenAPI 3.1 is JSON Schema 2020-12, which has no `nullable`
            // keyword — that was 3.0. Nullability is a type union. Using
            // `nullable: true` under a 3.1 header silently produces clients
            // that mis-handle exactly the fields whose null matters most here
            // (a null calculation is "not computed", not "nothing owed").
            externalRef: { type: ["string", "null"] },
            vessel: { type: "string" },
            voyageRef: { type: "string" },
            port: { type: "string" },
            calculation: {
              type: ["object", "null"],
              description: "Null until confirmed events exist and a calculation is stored.",
              properties: {
                allowedHours: { type: "number" },
                usedHours: { type: "number" },
                demurrageAmount: { type: "number" },
                despatchAmount: { type: "number" },
                currency: { type: "string" },
                computedAt: { type: "string", format: "date-time" },
              },
            },
            timeBar: {
              type: "object",
              properties: {
                deadline: { type: ["string", "null"], format: "date-time" },
                daysRemaining: { type: ["integer", "null"] },
                state: {
                  type: "string",
                  enum: ["no_anchor", "ok", "warning", "critical", "expired"],
                  description:
                    "`no_anchor` means no confirmed completion event, so no deadline can be computed yet.",
                },
                packComplete: { type: "boolean" },
              },
            },
            disputes: {
              type: "object",
              description: "Reports `withheld: true` when the key lacks disputes:read.",
            },
          },
        },
        WebhookRegistration: {
          type: "object",
          required: ["url", "eventTypes"],
          properties: {
            url: { type: "string", format: "uri", description: "https only; must not be a private address." },
            eventTypes: {
              type: "array",
              minItems: 1,
              items: { type: "string", enum: [...TIME_BAR_EVENTS] },
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string", description: "Stable machine-readable code." },
            message: { type: "string" },
            details: {},
          },
        },
      },
    },
    "x-scopes": Object.fromEntries(API_SCOPES.map((s) => [s, SCOPE_DESCRIPTIONS[s]])),
  };
}

function jsonSchemaRef(name: string) {
  return { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } };
}

function errorResponse(description: string) {
  return { description, content: jsonSchemaRef("Error") };
}
