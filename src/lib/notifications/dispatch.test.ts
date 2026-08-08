// Tests for the outbox → inbox fan-out.
//
// What is pinned here is POLICY: who gets told, who does not, and what happens
// on the redelivery that at-least-once guarantees will eventually occur. The
// expensive failures are all in this file — an alert delivered to nobody, an
// alert delivered twice, or an event that sticks at the head of the queue and
// silently stops every later notification.

import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EVENT_TYPES, MAX_ATTEMPTS } from "@/lib/events/outbox";
import { dispatchNotifications } from "./dispatch";
import { NOTIFICATION_KINDS } from "./rules";

const COMPANY = "22222222-2222-2222-2222-222222222222";
const CLAIM = "44444444-4444-4444-4444-444444444444";

const ADMIN = "a0000000-0000-0000-0000-000000000001";
const FINANCE = "a0000000-0000-0000-0000-000000000002";
const OPERATOR = "a0000000-0000-0000-0000-000000000003";
const VIEWER = "a0000000-0000-0000-0000-000000000004";

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

interface NotificationRow {
  id: string;
  user_id: string;
  dedupe_key: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
}

interface State {
  events: EventRow[];
  members: Array<{ user_id: string; role: string | null }>;
  notifications: NotificationRow[];
  consumptions: Array<{ event_id: number; consumer: string; processed_at: string | null; attempts: number }>;
  failRosterRead?: boolean;
  failNotificationWrite?: boolean;
}

function evt(over: Partial<EventRow> & { event_type: string }): EventRow {
  return {
    id: 1,
    company_id: COMPANY,
    aggregate: "claim",
    aggregate_id: CLAIM,
    payload: { claim_id: CLAIM },
    idempotency_key: `key-${over.id ?? 1}`,
    occurred_at: "2026-08-06T00:00:00.000Z",
    processed_at: null,
    attempts: 0,
    last_error: null,
    ...over,
  };
}

function fullRoster() {
  return [
    { user_id: ADMIN, role: "admin" },
    { user_id: FINANCE, role: "finance_manager" },
    { user_id: OPERATOR, role: "operator" },
    { user_id: VIEWER, role: "viewer" },
  ];
}

/** A Supabase stand-in covering exactly the calls the dispatcher makes. */
function fakeDb(state: State): SupabaseClient {
  let seq = 0;
  const api = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "unprocessed_domain_events") throw new Error(`unexpected rpc ${fn}`);
      const consumer = args.p_consumer as string;
      // The anti-join the real RPC performs: events with no COMPLETED
      // consumption row for this consumer.
      const rows = state.events
        .filter((e) => {
          const c = state.consumptions.find((x) => x.event_id === e.id && x.consumer === consumer);
          return !c || c.processed_at === null;
        })
        .map((e) => {
          const c = state.consumptions.find((x) => x.event_id === e.id && x.consumer === consumer);
          // attempts are THIS consumer's, not the event's.
          return { ...e, attempts: c?.attempts ?? 0 };
        })
        .sort((a, b) => a.id - b.id);
      return { data: rows, error: null };
    },
    from: (table: string) => {
      if (table === "company_members") {
        return {
          select: () => ({
            eq: async () =>
              state.failRosterRead
                ? { data: null, error: { message: "connection reset" } }
                : { data: state.members, error: null },
          }),
        };
      }
      if (table === "notifications") {
        return {
          upsert: (rows: Array<Record<string, unknown>>, opts: { ignoreDuplicates?: boolean }) => ({
            select: async () => {
              if (state.failNotificationWrite) {
                return { data: null, error: { message: "write failed" } };
              }
              const created: NotificationRow[] = [];
              for (const r of rows) {
                const key = String(r.dedupe_key);
                const uid = String(r.user_id);
                const exists = state.notifications.some(
                  (n) => n.user_id === uid && n.dedupe_key === key
                );
                // The unique constraint with duplicates ignored: an existing
                // row is left exactly as it is, read_at included.
                if (exists && opts.ignoreDuplicates) continue;
                const row: NotificationRow = {
                  id: `n${++seq}`,
                  user_id: uid,
                  dedupe_key: key,
                  kind: String(r.kind),
                  severity: String(r.severity),
                  title: String(r.title),
                  body: String(r.body),
                  href: (r.href as string) ?? null,
                  read_at: null,
                };
                state.notifications.push(row);
                created.push(row);
              }
              return { data: created, error: null };
            },
          }),
        };
      }
      if (table === "domain_event_consumptions") {
        return {
          upsert: async (row: Record<string, unknown>) => {
            const id = row.event_id as number;
            const consumer = row.consumer as string;
            const existing = state.consumptions.find(
              (c) => c.event_id === id && c.consumer === consumer
            );
            const next = {
              event_id: id,
              consumer,
              processed_at: (row.processed_at as string | null) ?? null,
              attempts: (row.attempts as number) ?? existing?.attempts ?? 0,
            };
            if (existing) Object.assign(existing, next);
            else state.consumptions.push(next);
            return { error: null };
          },
        };
      }
      if (table === "domain_events") {
        return {
          update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return api as unknown as SupabaseClient;
}

function baseState(over: Partial<State> = {}): State {
  return {
    events: [],
    members: fullRoster(),
    notifications: [],
    consumptions: [],
    ...over,
  };
}

const recipientsOf = (s: State, kind: string) =>
  s.notifications.filter((n) => n.kind === kind).map((n) => n.user_id).sort();

describe("who gets told", () => {
  test("an agreed claim reaches finance managers and admins, not operators", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.created).toBe(2);
    expect(recipientsOf(state, NOTIFICATION_KINDS.CLAIM_AGREED)).toEqual([ADMIN, FINANCE].sort());
  });

  test("a negotiation result reaches everyone who does claim work, including the admin", async () => {
    const state = baseState({
      events: [
        evt({
          id: 1,
          event_type: EVENT_TYPES.NEGOTIATION_COMPLETED,
          payload: { claim_id: CLAIM, room_id: "r1", recommended_settlement: 1000, currency: "USD" },
        }),
      ],
    });
    await dispatchNotifications(fakeDb(state), {});

    expect(recipientsOf(state, NOTIFICATION_KINDS.NEGOTIATION_PROPOSED)).toEqual(
      [ADMIN, FINANCE, OPERATOR].sort()
    );
  });

  test("a viewer never receives anything", async () => {
    const state = baseState({
      events: [
        evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY }),
        evt({
          id: 2,
          event_type: EVENT_TYPES.NEGOTIATION_COMPLETED,
          payload: { claim_id: CLAIM, room_id: "r1" },
        }),
      ],
    });
    await dispatchNotifications(fakeDb(state), {});

    expect(state.notifications.some((n) => n.user_id === VIEWER)).toBe(false);
  });

  test("a tenant with nobody who can act is acked, not left to block the queue", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
      members: [{ user_id: VIEWER, role: "viewer" }],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.noRecipients).toBe(1);
    expect(report.created).toBe(0);
    expect(state.consumptions[0].processed_at).not.toBeNull();
  });
});

describe("idempotency", () => {
  test("redelivering the same event creates nothing the second time", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
    });

    const first = await dispatchNotifications(fakeDb(state), {});
    expect(first.created).toBe(2);

    // Simulate a crash between the write and the ack: the event is outstanding
    // again, which is precisely the at-least-once case.
    state.consumptions = [];
    const second = await dispatchNotifications(fakeDb(state), {});

    expect(second.created).toBe(0);
    expect(state.notifications).toHaveLength(2);
  });

  // The subtle one. `upsert` with merge semantics would overwrite read_at back
  // to null and resurrect an alert somebody had already dealt with.
  test("a redelivery does not mark a read notification unread again", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
    });
    await dispatchNotifications(fakeDb(state), {});
    for (const n of state.notifications) n.read_at = "2026-08-06T09:00:00.000Z";

    state.consumptions = [];
    await dispatchNotifications(fakeDb(state), {});

    expect(state.notifications.every((n) => n.read_at !== null)).toBe(true);
  });
});

describe("events nobody needs to hear about", () => {
  test("claim.recomputed is acked and produces no notification", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.CLAIM_RECOMPUTED })],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.skipped).toBe(1);
    expect(report.created).toBe(0);
    // Acked: an un-acked skip would be re-read on every sweep forever.
    expect(state.consumptions[0].processed_at).not.toBeNull();
  });

  test("a non-decision-grade risk is acked silently", async () => {
    const state = baseState({
      events: [
        evt({
          id: 1,
          event_type: EVENT_TYPES.RISK_ASSESSED,
          payload: { risk_id: "r1", decision_grade: false, demurrage_probability: 0.99 },
        }),
      ],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.created).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

describe("failure handling", () => {
  test("a roster read failure leaves the event outstanding for retry", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
      failRosterRead: true,
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.failed).toBe(1);
    expect(state.consumptions[0].processed_at).toBeNull();
    expect(state.consumptions[0].attempts).toBe(1);
  });

  test("a write failure does not ack the event", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
      failNotificationWrite: true,
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.failed).toBe(1);
    expect(report.created).toBe(0);
    expect(state.consumptions[0].processed_at).toBeNull();
  });

  test("a poisoned event dead-letters instead of retrying forever", async () => {
    const state = baseState({
      events: [evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY })],
      consumptions: [
        { event_id: 1, consumer: "notifications", processed_at: null, attempts: MAX_ATTEMPTS },
      ],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.deadLettered).toBe(1);
    expect(report.created).toBe(0);
  });

  test("one failing event does not stop the ones behind it", async () => {
    const state = baseState({
      events: [
        evt({ id: 1, event_type: EVENT_TYPES.SETTLEMENT_READY, attempts: MAX_ATTEMPTS }),
        evt({ id: 2, event_type: EVENT_TYPES.SETTLEMENT_READY, idempotency_key: "key-2" }),
      ],
      consumptions: [
        { event_id: 1, consumer: "notifications", processed_at: null, attempts: MAX_ATTEMPTS },
      ],
    });
    const report = await dispatchNotifications(fakeDb(state), {});

    expect(report.deadLettered).toBe(1);
    expect(report.created).toBe(2);
  });
});
