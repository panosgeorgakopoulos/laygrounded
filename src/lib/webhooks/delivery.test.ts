// Webhook delivery retry semantics.
//
// The behaviour under test did not exist before: delivery was a single attempt
// with `attempts` hard-coded to 1. A partner whose endpoint blipped never
// learned their trucks were about to idle.

import { afterEach, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_DELIVERY_ATTEMPTS, backoffMs, enqueueDelivery, runPendingDeliveries } from "./delivery";
import { verifySignatureV2 } from "./signing";

const NOW = new Date("2026-08-01T12:00:00Z");
const SECRET = "whsec_delivery";

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  response_status: number | null;
  delivered_at: string | null;
}

interface State {
  deliveries: DeliveryRow[];
  hooks: Array<{ id: string; url: string; secret: string; status: string; event_types: string[]; company_id: string; config: unknown }>;
  duplicate: boolean;
}

function makeDb(state: State): SupabaseClient {
  const api = {
    from(table: string) {
      const ctx: { table: string; action: string; payload: any; filters: Record<string, unknown> } = {
        table,
        action: "select",
        payload: null,
        filters: {},
      };
      const run = (shape: "single" | "many") => {
        if (ctx.table === "api_webhook_deliveries") {
          if (ctx.action === "insert") {
            if (state.duplicate) return { data: null, error: { code: "23505", message: "dup" } };
            const row: DeliveryRow = {
              id: `d-${state.deliveries.length + 1}`,
              webhook_id: ctx.payload.webhook_id,
              event_type: ctx.payload.event_type,
              payload: ctx.payload.payload,
              status: "pending",
              attempts: 0,
              next_attempt_at: NOW.toISOString(),
              last_error: null,
              response_status: null,
              delivered_at: null,
            };
            state.deliveries.push(row);
            return { data: { id: row.id }, error: null };
          }
          if (ctx.action === "update") {
            const rows = state.deliveries.filter(
              (d) =>
                d.id === ctx.filters.id &&
                (ctx.filters.status === undefined || d.status === ctx.filters.status)
            );
            for (const r of rows) Object.assign(r, ctx.payload);
            return { data: rows, error: null };
          }
          const due = state.deliveries.filter((d) => d.status === "pending");
          return { data: due, error: null };
        }
        if (ctx.table === "api_webhooks") {
          const row = state.hooks.find((h) => h.id === ctx.filters.id) ?? null;
          return { data: row, error: null };
        }
        return { data: shape === "single" ? null : [], error: null };
      };
      const builder: any = {
        select: () => builder,
        insert: (p: any) => ((ctx.action = "insert"), (ctx.payload = p), builder),
        update: (p: any) => ((ctx.action = "update"), (ctx.payload = p), builder),
        eq: (c: string, v: unknown) => ((ctx.filters[c] = v), builder),
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(run("single")),
        single: () => Promise.resolve(run("single")),
        then: (f: any, r: any) => Promise.resolve(run("many")).then(f, r),
      };
      return builder;
    },
  };
  return api as unknown as SupabaseClient;
}

function baseState(over: Partial<State> = {}): State {
  return {
    deliveries: [
      {
        id: "d-1",
        webhook_id: "hook-1",
        event_type: "hinterland.delay_forecast",
        payload: { event: "hinterland.delay_forecast", delayHoursP90: 36 },
        status: "pending",
        attempts: 0,
        next_attempt_at: NOW.toISOString(),
        last_error: null,
        response_status: null,
        delivered_at: null,
      },
    ],
    hooks: [
      {
        id: "hook-1",
        url: "https://logistics.example.test/hooks",
        secret: SECRET,
        status: "active",
        event_types: ["hinterland.delay_forecast"],
        company_id: "c-1",
        config: {},
      },
    ],
    duplicate: false,
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return calls;
}

describe("successful delivery", () => {
  test("marks delivered and records the status", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));
    const state = baseState();
    const report = await runPendingDeliveries(makeDb(state), 25, NOW);

    expect(report).toMatchObject({ claimed: 1, delivered: 1, retrying: 0, dead: 0 });
    expect(state.deliveries[0].status).toBe("delivered");
    expect(state.deliveries[0].attempts).toBe(1);
    expect(state.deliveries[0].delivered_at).toBeTruthy();
  });

  test("the request carries a verifiable v2 signature over the exact body", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    await runPendingDeliveries(makeDb(baseState()), 25, NOW);

    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    const verdict = verifySignatureV2(String(init.body), headers["x-laygrounded-signature-v2"], SECRET, {
      now: NOW,
    });
    expect(verdict).toEqual({ valid: true });
    expect(headers["x-laygrounded-event"]).toBe("hinterland.delay_forecast");
  });

  test("redirects are refused so a signed payload cannot be bounced internally", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    await runPendingDeliveries(makeDb(baseState()), 25, NOW);
    expect(calls[0].init.redirect).toBe("error");
  });
});

describe("retry classification", () => {
  test("a 500 is retriable and stays pending with a later next_attempt_at", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const state = baseState();
    const report = await runPendingDeliveries(makeDb(state), 25, NOW);

    expect(report.retrying).toBe(1);
    expect(state.deliveries[0].status).toBe("pending");
    expect(state.deliveries[0].attempts).toBe(1);
    expect(new Date(state.deliveries[0].next_attempt_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a 429 is retriable", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }));
    const state = baseState();
    expect((await runPendingDeliveries(makeDb(state), 25, NOW)).retrying).toBe(1);
  });

  test("a network failure is retriable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const state = baseState();
    const report = await runPendingDeliveries(makeDb(state), 25, NOW);
    expect(report.retrying).toBe(1);
    expect(state.deliveries[0].last_error).toContain("ECONNREFUSED");
  });

  test("a 400 is NOT retriable — it dead-letters immediately", async () => {
    // Retrying an unchanged body against a deterministic rejection just burns
    // attempts and delays the dead letter a human needs to see.
    stubFetch(() => new Response("bad payload", { status: 400 }));
    const state = baseState();
    const report = await runPendingDeliveries(makeDb(state), 25, NOW);

    expect(report.dead).toBe(1);
    expect(report.retrying).toBe(0);
    expect(state.deliveries[0].status).toBe("dead");
    expect(state.deliveries[0].attempts).toBe(1);
  });

  test("a 404 dead-letters immediately too", async () => {
    stubFetch(() => new Response("no such endpoint", { status: 404 }));
    const state = baseState();
    expect((await runPendingDeliveries(makeDb(state), 25, NOW)).dead).toBe(1);
  });

  test("a 408 timeout IS retriable despite being 4xx", async () => {
    stubFetch(() => new Response("timeout", { status: 408 }));
    const state = baseState();
    expect((await runPendingDeliveries(makeDb(state), 25, NOW)).retrying).toBe(1);
  });
});

describe("dead-lettering", () => {
  test("gives up at the attempt ceiling", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const state = baseState();
    state.deliveries[0].attempts = MAX_DELIVERY_ATTEMPTS - 1;

    const report = await runPendingDeliveries(makeDb(state), 25, NOW);
    expect(report.dead).toBe(1);
    expect(state.deliveries[0].status).toBe("dead");
    expect(state.deliveries[0].attempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  test("one attempt earlier it still retries", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const state = baseState();
    state.deliveries[0].attempts = MAX_DELIVERY_ATTEMPTS - 2;
    expect((await runPendingDeliveries(makeDb(state), 25, NOW)).retrying).toBe(1);
  });

  test("a paused subscription dead-letters rather than delivering", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));
    const state = baseState();
    state.hooks[0].status = "paused";
    const report = await runPendingDeliveries(makeDb(state), 25, NOW);
    expect(report.dead).toBe(1);
    expect(state.deliveries[0].last_error).toContain("paused");
  });
});

describe("backoff", () => {
  test("grows with attempts and stays bounded", () => {
    const first = backoffMs(1);
    const later = backoffMs(5);
    expect(later).toBeGreaterThan(first);
    // Capped so a recovered endpoint drains rather than crawls.
    expect(backoffMs(50)).toBeLessThanOrEqual(15 * 60_000);
  });

  test("is jittered, so a fleet of failed deliveries does not thunder", () => {
    const samples = new Set(Array.from({ length: 20 }, () => backoffMs(3)));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("enqueue idempotency", () => {
  test("a duplicate idempotency key is a no-op, not an error", async () => {
    const state = baseState({ deliveries: [], duplicate: true });
    const result = await enqueueDelivery(
      makeDb(state),
      { id: "hook-1", company_id: "c-1", url: "u", secret: "s", event_types: [], status: "active", config: {} },
      { eventType: "hinterland.delay_forecast", idempotencyKey: "k", payload: {} }
    );
    expect(result).toEqual({ deliveryId: null, deduped: true });
    expect(state.deliveries).toHaveLength(0);
  });

  test("a fresh key queues a pending row", async () => {
    const state = baseState({ deliveries: [] });
    const result = await enqueueDelivery(
      makeDb(state),
      { id: "hook-1", company_id: "c-1", url: "u", secret: "s", event_types: [], status: "active", config: {} },
      { eventType: "hinterland.stoppage", idempotencyKey: "k", payload: { a: 1 } }
    );
    expect(result.deduped).toBe(false);
    expect(state.deliveries[0].status).toBe("pending");
  });
});
