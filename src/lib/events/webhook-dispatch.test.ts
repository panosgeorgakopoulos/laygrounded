// Tests for the hinterland outbox consumer.
//
// The first describe block is the most important in this file: it proves the
// two consumers are independent. Before `domain_event_consumptions`, processing
// state was a single `processed_at` flag, so adding this consumer would have
// silently stopped ERP pushes — no error, no log, just an integration that
// quietly stopped working.

import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchHinterlandWebhooks } from "./webhook-dispatch";
import { dispatchErpEvents } from "./erp-dispatch";
import { EVENT_TYPES, MAX_ATTEMPTS } from "./outbox";

const COMPANY = "22222222-2222-2222-2222-222222222222";
const OTHER_COMPANY = "33333333-3333-3333-3333-333333333333";
const CLAIM = "44444444-4444-4444-4444-444444444444";
const RISK = "55555555-5555-5555-5555-555555555555";
const NOW = new Date("2026-08-01T12:00:00Z");

interface EventRow {
  id: number;
  company_id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  occurred_at: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
}

interface ConsumptionRow {
  event_id: number;
  consumer: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
}

interface Subscription {
  id: string;
  company_id: string;
  url: string;
  secret: string;
  event_types: string[];
  status: string;
  config: Record<string, unknown>;
}

interface RiskRow {
  id: string;
  company_id: string;
  claim_id: string | null;
  vessel: string;
  voyage_ref: string | null;
  port: string;
  cargo: string | null;
  eta: string | null;
  decision_grade: boolean;
  p90_waiting_hours: number | null;
  p90_stoppage_hours: number | null;
  demurrage_probability: number;
  p90_exposure: number | null;
  currency: string | null;
}

interface State {
  events: EventRow[];
  consumptions: ConsumptionRow[];
  subscriptions: Subscription[];
  risks: RiskRow[];
  claims: Array<{ id: string; company_id: string; vessel: string; voyage_ref: string; port: string; cargo: string; status: string }>;
  calculations: Array<{ claim_id: string; breakdown: unknown[]; demurrage_amount: number; currency: string }>;
  deliveries: Array<{ webhook_id: string; event_type: string; idempotency_key: string; payload: any; claim_id: string | null }>;
  integrations: unknown[];
  duplicateKeys: Set<string>;
  failSubscriptionsRead?: boolean;
}

function consumptionFor(state: State, eventId: number, consumer: string) {
  return state.consumptions.find((c) => c.event_id === eventId && c.consumer === consumer);
}

function riskEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    company_id: COMPANY,
    aggregate: "pre_arrival_risk",
    aggregate_id: RISK,
    event_type: EVENT_TYPES.RISK_ASSESSED,
    payload: { risk_id: RISK, claim_id: CLAIM },
    idempotency_key: "risk.assessed:r-1",
    occurred_at: "2026-08-01T00:00:00Z",
    processed_at: null,
    attempts: 0,
    last_error: null,
    ...over,
  };
}

function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    id: "hook-1",
    company_id: COMPANY,
    url: "https://logistics.example.test/hooks",
    secret: "whsec_x",
    event_types: ["hinterland.delay_forecast", "hinterland.stoppage"],
    status: "active",
    config: {},
    ...over,
  };
}

function riskRow(over: Partial<RiskRow> = {}): RiskRow {
  return {
    id: RISK,
    company_id: COMPANY,
    claim_id: CLAIM,
    vessel: "AEGEAN TRADER",
    voyage_ref: "4201/2026",
    port: "Rotterdam",
    cargo: "Steam coal",
    eta: "2026-08-04T06:00:00Z",
    decision_grade: true,
    p90_waiting_hours: 30,
    p90_stoppage_hours: 6,
    demurrage_probability: 0.72,
    p90_exposure: 148_000,
    currency: "USD",
    ...over,
  };
}

function makeDb(state: State): SupabaseClient {
  const api = {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "unprocessed_domain_events") return Promise.resolve({ data: [], error: null });
      const consumer = String(args.p_consumer);
      const rows = state.events
        .filter((e) => !consumptionFor(state, e.id, consumer)?.processed_at)
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(args.p_limit ?? 100))
        .map((e) => {
          const c = consumptionFor(state, e.id, consumer);
          return { ...e, processed_at: null, attempts: c?.attempts ?? 0, last_error: c?.last_error ?? null };
        });
      return Promise.resolve({ data: rows, error: null });
    },
    from(table: string) {
      const ctx: { table: string; action: string; payload: any; filters: Record<string, unknown> } = {
        table,
        action: "select",
        payload: null,
        filters: {},
      };

      const run = (shape: "single" | "many") => {
        if (ctx.table === "domain_event_consumptions") {
          // markProcessedBy/markFailedBy upsert DIFFERENT subsets of columns,
          // so the payload is genuinely partial.
          const p = ctx.payload as Partial<ConsumptionRow> & { event_id: number; consumer: string };
          const existing = consumptionFor(state, p.event_id, p.consumer);
          if (existing) Object.assign(existing, p);
          else state.consumptions.push({ attempts: 0, last_error: null, processed_at: null, ...p });
          return { data: null, error: null };
        }
        if (ctx.table === "domain_events") return { data: null, error: null };

        if (ctx.table === "api_webhooks") {
          if (state.failSubscriptionsRead) {
            return { data: null, error: { message: "connection reset" } };
          }
          const rows = state.subscriptions.filter(
            (s) => s.company_id === ctx.filters.company_id && s.status === ctx.filters.status
          );
          return { data: rows, error: null };
        }

        if (ctx.table === "pre_arrival_risks") {
          const row = state.risks.find((r) => r.id === ctx.filters.id) ?? null;
          return { data: row, error: null };
        }

        if (ctx.table === "claims") {
          const row = state.claims.find((c) => c.id === ctx.filters.id) ?? null;
          return { data: row, error: null };
        }

        if (ctx.table === "laytime_calculations") {
          const row = state.calculations.find((c) => c.claim_id === ctx.filters.claim_id) ?? null;
          return { data: row, error: null };
        }

        if (ctx.table === "api_webhook_deliveries" && ctx.action === "insert") {
          const key = ctx.payload.idempotency_key as string;
          if (state.duplicateKeys.has(key)) {
            return { data: null, error: { code: "23505", message: "duplicate" } };
          }
          state.deliveries.push(ctx.payload);
          return { data: { id: `d-${state.deliveries.length}` }, error: null };
        }

        if (ctx.table === "integrations") return { data: [], error: null };

        return { data: shape === "single" ? null : [], error: null };
      };

      const builder: any = {
        select: () => builder,
        insert: (p: any) => ((ctx.action = "insert"), (ctx.payload = p), builder),
        update: (p: any) => ((ctx.action = "update"), (ctx.payload = p), builder),
        upsert: (p: any) => ((ctx.action = "upsert"), (ctx.payload = p), builder),
        eq: (c: string, v: unknown) => ((ctx.filters[c] = v), builder),
        is: () => builder,
        gt: () => builder,
        lte: () => builder,
        in: () => builder,
        not: () => builder,
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
    events: [riskEvent()],
    consumptions: [],
    subscriptions: [subscription()],
    risks: [riskRow()],
    claims: [],
    calculations: [],
    deliveries: [],
    integrations: [],
    duplicateKeys: new Set(),
    ...over,
  };
}

// === The reason domain_event_consumptions exists ===

describe("consumers are independent", () => {
  test("an event already handled by 'erp' is still delivered to 'hinterland'", () => {
    // With the old single processed_at flag this returned zero events and the
    // whole feature was dead on arrival.
    const state = baseState({
      consumptions: [
        { event_id: 1, consumer: "erp", processed_at: "2026-08-01T11:00:00Z", attempts: 0, last_error: null },
      ],
    });
    return dispatchHinterlandWebhooks(makeDb(state), { now: NOW }).then((report) => {
      expect(report.read).toBe(1);
      expect(report.enqueued).toBe(1);
    });
  });

  test("hinterland acking an event does not ack it for erp", async () => {
    const state = baseState();
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });

    expect(consumptionFor(state, 1, "hinterland")?.processed_at).toBeTruthy();
    expect(consumptionFor(state, 1, "erp")).toBeUndefined();

    // And the ERP dispatcher still sees it as outstanding.
    const erpReport = await dispatchErpEvents(makeDb(state));
    expect(erpReport.read).toBe(1);
  });

  test("a poisoned hinterland consumer does not dead-letter the event for erp", async () => {
    const state = baseState({
      consumptions: [
        { event_id: 1, consumer: "hinterland", processed_at: null, attempts: MAX_ATTEMPTS, last_error: "boom" },
      ],
    });
    const hinterland = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(hinterland.deadLettered).toBe(1);

    const erp = await dispatchErpEvents(makeDb(state));
    expect(erp.read).toBe(1); // unaffected
  });
});

// === Trigger policy ===

describe("delay forecasts", () => {
  test("a P90 delay over the threshold queues a notification", async () => {
    const state = baseState();
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });

    expect(report).toMatchObject({ read: 1, dispatched: 1, enqueued: 1 });
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0].event_type).toBe("hinterland.delay_forecast");
    expect(state.deliveries[0].payload.delayHoursP90).toBe(36);
    expect(state.deliveries[0].claim_id).toBe(CLAIM);
  });

  test("below the threshold, nothing is sent", async () => {
    const state = baseState({ risks: [riskRow({ p90_waiting_hours: 4, p90_stoppage_hours: 1 })] });
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
    expect(report.skipped).toBe(1);
    expect(consumptionFor(state, 1, "hinterland")?.processed_at).toBeTruthy();
  });

  test("an assessment with no recorded P90 sends nothing", async () => {
    // Rows predating the statistic. Silence is correct; a mean would not be.
    const state = baseState({ risks: [riskRow({ p90_waiting_hours: null })] });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("a non-decision-grade assessment sends nothing", async () => {
    const state = baseState({
      risks: [riskRow({ decision_grade: false, p90_waiting_hours: 500 })],
    });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("per-subscription thresholds are applied independently", async () => {
    const state = baseState({
      subscriptions: [
        subscription({ id: "eager", config: { hinterland_delay_threshold_hours: 12 } }),
        subscription({ id: "patient", config: { hinterland_delay_threshold_hours: 48 } }),
      ],
    });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries.map((d) => d.webhook_id)).toEqual(["eager"]);
  });

  test("a partner not subscribed to the event type receives nothing", async () => {
    const state = baseState({
      subscriptions: [subscription({ event_types: ["time_bar.warning"] })],
    });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("the payload is signed-ready and self-describing", async () => {
    const state = baseState();
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    const p = state.deliveries[0].payload;
    expect(p.basis).toBe("forecast");
    expect(p.vessel).toBe("AEGEAN TRADER");
    expect(p.thresholdHours).toBe(24);
    expect(p.interpretation).toContain("P90");
  });
});

describe("observed stoppages", () => {
  const claimRecomputed: EventRow = {
    ...riskEvent(),
    id: 2,
    aggregate: "claim",
    aggregate_id: CLAIM,
    event_type: EVENT_TYPES.CLAIM_RECOMPUTED,
    payload: { claim_id: CLAIM },
    idempotency_key: "claim.recomputed:calc-9",
  };

  function stoppageState(hours: number): State {
    return baseState({
      events: [claimRecomputed],
      risks: [],
      claims: [
        {
          id: CLAIM,
          company_id: COMPANY,
          vessel: "IONIAN PIONEER",
          voyage_ref: "12/2026",
          port: "Santos",
          cargo: "Soybeans",
          status: "demurrage",
        },
      ],
      calculations: [
        {
          claim_id: CLAIM,
          demurrage_amount: 96_000,
          currency: "USD",
          breakdown: [
            { counts: true, duration_hours: 40, end_time: "2026-08-05T00:00:00Z" },
            { counts: false, duration_hours: hours, end_time: "2026-08-06T18:00:00Z" },
          ],
        },
      ],
    });
  }

  test("a long excepted period notifies the hinterland", async () => {
    const state = stoppageState(31.5);
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });

    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0].event_type).toBe("hinterland.stoppage");
    expect(state.deliveries[0].payload.stoppageHours).toBe(31.5);
    expect(state.deliveries[0].payload.basis).toBe("observed");
    // Latest breakdown end becomes the revised completion.
    expect(state.deliveries[0].payload.revisedCompletionISO).toBe("2026-08-06T18:00:00Z");
  });

  test("counting rows are not mistaken for stoppage", async () => {
    // Only NON-counting breakdown rows are interruptions the engine allowed.
    const state = stoppageState(2);
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("a claim with no calculation sends nothing", async () => {
    const state = stoppageState(31.5);
    state.calculations = [];
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });
});

describe("safety", () => {
  test("settlement.changed produces no hinterland traffic", async () => {
    const state = baseState({
      events: [
        riskEvent({
          event_type: EVENT_TYPES.SETTLEMENT_CHANGED,
          payload: { settlement_id: "s-1", claim_id: CLAIM, status: "cleared" },
        }),
      ],
    });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("a risk belonging to another company is never sent", async () => {
    // The worker is service-role; this check is the only tenant boundary.
    const state = baseState({ risks: [riskRow({ company_id: OTHER_COMPANY })] });
    await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(state.deliveries).toHaveLength(0);
  });

  test("a deleted assessment is a no-op, not an error", async () => {
    const state = baseState({ risks: [] });
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
  });

  test("no subscriptions is a steady state, not a failure", async () => {
    const state = baseState({ subscriptions: [] });
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
  });

  test("a redelivered event dedupes instead of paging the partner twice", async () => {
    const state = baseState({
      duplicateKeys: new Set(["evt:risk.assessed:r-1:hinterland.delay_forecast:24"]),
    });
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(report.deduped).toBe(1);
    expect(report.enqueued).toBe(0);
  });

  test("a read failure leaves the event outstanding with its error", async () => {
    const state = baseState({ failSubscriptionsRead: true });
    const report = await dispatchHinterlandWebhooks(makeDb(state), { now: NOW });
    expect(report.failed).toBe(1);
    expect(consumptionFor(state, 1, "hinterland")?.attempts).toBe(1);
    expect(consumptionFor(state, 1, "hinterland")?.processed_at).toBeFalsy();
    expect(consumptionFor(state, 1, "hinterland")?.last_error).toContain(
      "SUBSCRIPTIONS_READ_FAILED"
    );
  });
});
