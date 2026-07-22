// OpenAPI 3.1 description of the Audit Trail API.
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
  "disputes:read": "Read counterparty proposals and clause flags for a voyage.",
  "webhooks:manage": "Register, list and remove webhook subscriptions.",
};

export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "LayGrounded Audit Trail API",
      version: "1.0.0",
      description: [
        "Enterprise ERP/TMS integration surface for laytime and demurrage claims.",
        "",
        "## Authentication",
        "Every endpoint takes an API key as `Authorization: Bearer <key>`. Keys are issued",
        "in the LayGrounded app (they cannot be minted through this API — a leaked key must",
        "not be able to mint more). Only a hash is stored: a key is shown once, at creation.",
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
    ],
    paths: {
      "/api/v1/audit/voyages": {
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
      "/api/v1/audit/voyages/{claimId}": {
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
      "/api/v1/audit/webhooks": {
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
      "/api/v1/audit/webhooks/{webhookId}": {
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
