// Tests for the outbox → ERP dispatcher.
//
// What is being pinned here is POLICY, not plumbing: which events reach a
// customer's accounting system, and which must not. Every case below is a
// decision that would be expensive to get wrong in production — a stream of
// contradictory demurrage figures during drafting, a forecast booked as a cost,
// or one tenant's claim pushed to another tenant's ERP.

import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchErpEvents } from "./erp-dispatch";
import { EVENT_TYPES, MAX_ATTEMPTS } from "./outbox";
import { assertSupportsJobKind, supportsJobKind } from "@/lib/integrations/sync";
import type { IntegrationRow } from "@/lib/integrations/types";

const COMPANY = "22222222-2222-2222-2222-222222222222";
const OTHER_COMPANY = "33333333-3333-3333-3333-333333333333";
const CLAIM = "44444444-4444-4444-4444-444444444444";

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

interface State {
  events: EventRow[];
  claims: Array<{ id: string; status: string; company_id: string }>;
  integrations: IntegrationRow[];
  syncJobs: Array<{ integration_id: string; kind: string; claim_id: string | null; idempotency_key: string }>;
  /** Idempotency keys that should report a unique violation (already queued). */
  duplicateKeys: Set<string>;
  failIntegrationsRead?: boolean;
}

function integration(over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    company_id: COMPANY,
    provider: "MOCK_ERP",
    display_name: "Test",
    base_url: "https://erp.example.test",
    auth: {},
    config: {},
    status: "active",
    last_error: null,
    last_sync_at: null,
    ...over,
  };
}

function claimEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    company_id: COMPANY,
    aggregate: "claim",
    aggregate_id: CLAIM,
    event_type: EVENT_TYPES.CLAIM_RECOMPUTED,
    payload: { claim_id: CLAIM, demurrage_amount: 125_000, currency: "USD" },
    idempotency_key: "claim.recomputed:calc-1",
    occurred_at: "2026-07-31T00:00:00Z",
    processed_at: null,
    attempts: 0,
    last_error: null,
    ...over,
  };
}

/** A minimal Supabase query-builder double covering the calls this path makes. */
function makeDb(state: State): SupabaseClient {
  const api = {
    from(table: string) {
      const ctx: {
        table: string;
        action: string;
        payload: any;
        filters: Record<string, unknown>;
      } = { table, action: "select", payload: null, filters: {} };

      const run = (shape: "single" | "many") => {
        if (ctx.table === "domain_events") {
          if (ctx.action === "update") {
            const row = state.events.find((e) => e.id === ctx.filters.id);
            if (row) Object.assign(row, ctx.payload);
            return { data: null, error: null };
          }
          const rows = state.events.filter((e) => e.processed_at === null);
          return { data: rows, error: null };
        }

        if (ctx.table === "claims") {
          const row = state.claims.find((c) => c.id === ctx.filters.id) ?? null;
          return { data: shape === "single" ? row : row ? [row] : [], error: null };
        }

        if (ctx.table === "integrations") {
          if (state.failIntegrationsRead) {
            return { data: null, error: { message: "connection reset", code: "08006" } };
          }
          const rows = state.integrations.filter(
            (i) => i.company_id === ctx.filters.company_id && i.status === ctx.filters.status
          );
          return { data: rows, error: null };
        }

        if (ctx.table === "sync_jobs" && ctx.action === "insert") {
          const key = ctx.payload.idempotency_key as string;
          if (state.duplicateKeys.has(key)) {
            // 23505: the live-jobs unique index. That is the idempotency
            // contract firing, not an error.
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          state.syncJobs.push(ctx.payload);
          return { data: { id: `job-${state.syncJobs.length}` }, error: null };
        }

        return { data: shape === "single" ? null : [], error: null };
      };

      const builder: any = {
        select: () => builder,
        insert: (p: any) => ((ctx.action = "insert"), (ctx.payload = p), builder),
        update: (p: any) => ((ctx.action = "update"), (ctx.payload = p), builder),
        upsert: (p: any) => ((ctx.action = "upsert"), (ctx.payload = p), builder),
        eq: (col: string, val: unknown) => ((ctx.filters[col] = val), builder),
        is: () => builder,
        gt: () => builder,
        in: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(run("single")),
        single: () => Promise.resolve(run("single")),
        then: (onF: any, onR: any) => Promise.resolve(run("many")).then(onF, onR),
      };
      return builder;
    },
  };
  return api as unknown as SupabaseClient;
}

function baseState(over: Partial<State> = {}): State {
  return {
    events: [claimEvent()],
    claims: [{ id: CLAIM, status: "demurrage", company_id: COMPANY }],
    integrations: [integration()],
    syncJobs: [],
    duplicateKeys: new Set(),
    ...over,
  };
}

describe("a finalized claim reaches the ERP", () => {
  test("claim.recomputed enqueues an invoice and a ledger push", async () => {
    const state = baseState();
    const report = await dispatchErpEvents(makeDb(state));

    expect(report).toMatchObject({ read: 1, dispatched: 1, enqueued: 2, skipped: 0 });
    expect(state.syncJobs.map((j) => j.kind).sort()).toEqual(["push_invoice", "push_ledger"]);
    expect(state.syncJobs[0].claim_id).toBe(CLAIM);
  });

  test("the event is marked processed once the jobs are ENQUEUED", async () => {
    // Not once the ERP accepted them: delivery is sync_jobs' responsibility,
    // with its own backoff and dead letter. Waiting here would rebuild a
    // distributed transaction by hand.
    const state = baseState();
    await dispatchErpEvents(makeDb(state));
    expect(state.events[0].processed_at).not.toBeNull();
  });

  test("the sync job's idempotency key derives from the event's", async () => {
    // A redelivered event must not enqueue a second push of identical numbers.
    const state = baseState();
    await dispatchErpEvents(makeDb(state));
    for (const job of state.syncJobs) {
      expect(job.idempotency_key).toStartWith("evt:claim.recomputed:calc-1:");
    }
  });

  test("a redelivered event dedupes instead of double-pushing", async () => {
    const state = baseState({
      duplicateKeys: new Set([
        "evt:claim.recomputed:calc-1:push_invoice",
        "evt:claim.recomputed:calc-1:push_ledger",
      ]),
    });
    const report = await dispatchErpEvents(makeDb(state));
    expect(report.deduped).toBe(2);
    expect(report.enqueued).toBe(0);
    expect(state.syncJobs).toHaveLength(0);
  });

  test("every active integration in the company receives the push", async () => {
    const state = baseState({
      integrations: [
        integration({ id: "int-1", provider: "MOCK_ERP" }),
        integration({ id: "int-2", provider: "DANAOS" }),
      ],
    });
    await dispatchErpEvents(makeDb(state));
    expect(state.syncJobs).toHaveLength(4); // 2 kinds x 2 integrations
    expect(new Set(state.syncJobs.map((j) => j.integration_id))).toEqual(
      new Set(["int-1", "int-2"])
    );
  });

  test("a paused integration receives nothing", async () => {
    const state = baseState({ integrations: [integration({ status: "paused" })] });
    const report = await dispatchErpEvents(makeDb(state));
    expect(state.syncJobs).toHaveLength(0);
    expect(report.skipped).toBe(1);
    expect(state.events[0].processed_at).not.toBeNull();
  });
});

describe("drafts must never reach an accounting system", () => {
  // A recompute fires on every edit. Pushing those would put a stream of
  // contradictory demurrage figures into the customer's ERP and destroy trust
  // in the integration faster than any outage.
  for (const status of ["draft", "processing", "in_progress", "failed"]) {
    test(`status '${status}' produces no ERP traffic`, async () => {
      const state = baseState({
        claims: [{ id: CLAIM, status, company_id: COMPANY }],
      });
      const report = await dispatchErpEvents(makeDb(state));
      expect(state.syncJobs).toHaveLength(0);
      expect(report.skipped).toBe(1);
      // Still processed: it is a decision, not a deferral.
      expect(state.events[0].processed_at).not.toBeNull();
    });
  }

  for (const status of ["completed", "demurrage", "despatch"]) {
    test(`status '${status}' does push`, async () => {
      const state = baseState({ claims: [{ id: CLAIM, status, company_id: COMPANY }] });
      await dispatchErpEvents(makeDb(state));
      expect(state.syncJobs.length).toBeGreaterThan(0);
    });
  }
});

describe("event types that must produce no ERP traffic", () => {
  test("risk.assessed is ignored — a forecast is not a fact to book", async () => {
    const state = baseState({
      events: [
        claimEvent({
          event_type: EVENT_TYPES.RISK_ASSESSED,
          payload: { risk_id: "r-1", claim_id: CLAIM, expected_exposure: 90_000 },
          idempotency_key: "risk.assessed:r-1",
        }),
      ],
    });
    const report = await dispatchErpEvents(makeDb(state));
    expect(state.syncJobs).toHaveLength(0);
    expect(report.skipped).toBe(1);
  });

  test("an unrecognised event type produces nothing", async () => {
    // Adding an event type to the outbox must never surprise a customer's ERP.
    const state = baseState({
      events: [claimEvent({ event_type: "claim.archived", idempotency_key: "x:1" })],
    });
    await dispatchErpEvents(makeDb(state));
    expect(state.syncJobs).toHaveLength(0);
  });

  test("settlement.changed pushes only when cleared", async () => {
    for (const [status, expected] of [
      ["pending", 0],
      ["failed", 0],
      ["cleared", 1],
    ] as const) {
      const state = baseState({
        events: [
          claimEvent({
            event_type: EVENT_TYPES.SETTLEMENT_CHANGED,
            payload: { settlement_id: "s-1", claim_id: CLAIM, status },
            idempotency_key: `settlement.changed:s-1:${status}`,
          }),
        ],
      });
      await dispatchErpEvents(makeDb(state));
      expect(state.syncJobs).toHaveLength(expected);
    }
  });
});

describe("tenancy and missing aggregates", () => {
  test("a claim belonging to another company is never pushed", async () => {
    // The worker is service-role: nothing but this check stops a malformed
    // payload naming another tenant's claim from reaching THIS tenant's ERP.
    const state = baseState({
      claims: [{ id: CLAIM, status: "demurrage", company_id: OTHER_COMPANY }],
    });
    const report = await dispatchErpEvents(makeDb(state));
    expect(state.syncJobs).toHaveLength(0);
    expect(report.skipped).toBe(1);
  });

  test("a deleted claim is a no-op, not an error", async () => {
    // Events outlive their aggregates by design — no FK cascade.
    const state = baseState({ claims: [] });
    const report = await dispatchErpEvents(makeDb(state));
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(state.events[0].processed_at).not.toBeNull();
  });

  test("an event with no claim_id in its payload is skipped safely", async () => {
    const state = baseState({ events: [claimEvent({ payload: {} })] });
    const report = await dispatchErpEvents(makeDb(state));
    expect(report.failed).toBe(0);
    expect(state.syncJobs).toHaveLength(0);
  });
});

describe("failure handling", () => {
  test("a read failure records the attempt and leaves the event outstanding", async () => {
    const state = baseState({ failIntegrationsRead: true });
    const report = await dispatchErpEvents(makeDb(state));

    expect(report.failed).toBe(1);
    expect(state.events[0].attempts).toBe(1);
    expect(state.events[0].last_error).toContain("INTEGRATIONS_READ_FAILED");
    // NOT processed: it must be retried.
    expect(state.events[0].processed_at).toBeNull();
  });

  test("a poison event is left alone once it hits the attempt ceiling", async () => {
    // Retrying it forever burns an attempt every sweep and hides fresher
    // failures behind it.
    const state = baseState({
      events: [claimEvent({ attempts: MAX_ATTEMPTS })],
      failIntegrationsRead: true,
    });
    const report = await dispatchErpEvents(makeDb(state));
    expect(report.deadLettered).toBe(1);
    expect(report.failed).toBe(0);
    expect(state.events[0].attempts).toBe(MAX_ATTEMPTS); // untouched
  });

  test("one failing event does not stop the others", async () => {
    const state = baseState({
      events: [
        claimEvent({ id: 1, attempts: MAX_ATTEMPTS }), // dead-lettered
        claimEvent({ id: 2, idempotency_key: "claim.recomputed:calc-2" }),
      ],
    });
    const report = await dispatchErpEvents(makeDb(state));
    expect(report.deadLettered).toBe(1);
    expect(report.dispatched).toBe(1);
    expect(state.syncJobs).toHaveLength(2);
  });
});

describe("capability gating at enqueue", () => {
  test("supportsJobKind reflects the adapter's declaration", () => {
    expect(supportsJobKind(integration({ provider: "DANAOS" }), "push_pnl")).toBe(true);
    // Ulysses is an operations system, not a commercial ledger.
    expect(supportsJobKind(integration({ provider: "ULYSSES" }), "push_pnl")).toBe(false);
    expect(supportsJobKind(integration({ provider: "ULYSSES" }), "push_invoice")).toBe(true);
    expect(supportsJobKind(integration({ provider: "VESON_IMOS" }), "pull_schedules")).toBe(false);
  });

  test("assertSupportsJobKind throws an actionable error, not a generic one", () => {
    // Rejected at the point the user asks, rather than dead-lettered six
    // attempts later.
    expect(() => assertSupportsJobKind(integration({ provider: "ULYSSES" }), "push_pnl")).toThrow(
      /UNSUPPORTED_JOB_KIND: ULYSSES does not support 'push_pnl'/
    );
    expect(() =>
      assertSupportsJobKind(integration({ provider: "DANAOS" }), "push_pnl")
    ).not.toThrow();
  });
});
