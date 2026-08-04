import { describe, expect, test } from "bun:test";
import { EVENT_TYPES, type DomainEvent } from "@/lib/events/outbox";
import { can, ROLES, type Role } from "@/lib/auth/roles";
import {
  DEMURRAGE_PROBABILITY_ALERT,
  DEMURRAGE_PROBABILITY_URGENT,
  NOTIFICATION_KINDS,
  draftFor,
} from "./rules";

function event(overrides: Partial<DomainEvent> & { eventType: string }): DomainEvent {
  return {
    id: 1,
    companyId: "c0000000-0000-0000-0000-000000000000",
    aggregate: "claim",
    aggregateId: "a0000000-0000-0000-0000-000000000000",
    payload: {},
    idempotencyKey: "k1",
    occurredAt: "2026-08-06T00:00:00.000Z",
    processedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

const CLAIM = "11111111-1111-1111-1111-111111111111";
const RISK = "22222222-2222-2222-2222-222222222222";

/** Which roles would actually receive a draft, via the Phase 14 ladder. */
function recipients(capability: Parameters<typeof can>[1]): Role[] {
  return ROLES.filter((r) => can(r, capability));
}

describe("negotiation.completed", () => {
  const base = event({
    eventType: EVENT_TYPES.NEGOTIATION_COMPLETED,
    payload: {
      room_id: "r1",
      claim_id: CLAIM,
      recommended_settlement: "48250.5",
      currency: "USD",
      settlement_probability: "0.62",
      converged: true,
    },
  });

  test("drafts an action for whoever does claim work", () => {
    const d = draftFor(base)!;
    expect(d.kind).toBe(NOTIFICATION_KINDS.NEGOTIATION_PROPOSED);
    expect(d.capability).toBe("claim.write");
    expect(d.severity).toBe("action");
    expect(d.href).toBe(`/claims/${CLAIM}/workspace`);
    expect(d.subjectId).toBe(CLAIM);
  });

  // numeric columns arrive as strings over PostgREST. Rendering them naively
  // produced "USD NaN" in a money field in an earlier phase; that class of bug
  // is exactly what reaches a user unchallenged.
  test("formats a string-typed numeric without producing NaN", () => {
    const d = draftFor(base)!;
    expect(d.body).toContain("USD 48,251");
    expect(d.body).not.toContain("NaN");
    expect(d.body).toContain("62%");
  });

  test("says so when the agents did not converge", () => {
    const d = draftFor(
      event({
        eventType: EVENT_TYPES.NEGOTIATION_COMPLETED,
        payload: { ...base.payload, converged: false },
      })
    )!;
    expect(d.body).toContain("gap remains");
  });

  test("survives a missing recommendation rather than rendering nothing", () => {
    const d = draftFor(
      event({
        eventType: EVENT_TYPES.NEGOTIATION_COMPLETED,
        payload: { room_id: "r1", claim_id: CLAIM, recommended_settlement: null },
      })
    )!;
    expect(d.body).toContain("an unstated amount");
    expect(d.body).not.toContain("NaN");
  });

  test("is silent with no claim to point at", () => {
    expect(draftFor(event({ eventType: EVENT_TYPES.NEGOTIATION_COMPLETED, payload: {} }))).toBeNull();
  });
});

describe("claim.settlement_ready", () => {
  test("is addressed to whoever can actually settle", () => {
    const d = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } })
    )!;
    expect(d.kind).toBe(NOTIFICATION_KINDS.CLAIM_AGREED);
    expect(d.capability).toBe("claim.settle");
    expect(recipients(d.capability)).toEqual(["finance_manager", "admin"]);
  });

  test("falls back to the aggregate id when the payload omits claim_id", () => {
    const d = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, aggregateId: CLAIM, payload: {} })
    )!;
    expect(d.subjectId).toBe(CLAIM);
  });
});

describe("risk.assessed", () => {
  const risky = {
    risk_id: RISK,
    claim_id: CLAIM,
    decision_grade: true,
    demurrage_probability: 0.61,
    p90_exposure: 92000,
    currency: "USD",
  };

  test("alerts above the threshold", () => {
    const d = draftFor(event({ eventType: EVENT_TYPES.RISK_ASSESSED, payload: risky }))!;
    expect(d.kind).toBe(NOTIFICATION_KINDS.RISK_EXPOSURE);
    expect(d.severity).toBe("action");
    expect(d.body).toContain("61%");
    expect(d.body).toContain("USD 92,000");
    expect(d.href).toBe(`/simulator/pre-arrival?risk=${RISK}`);
  });

  test("escalates to urgent when the tail is bad", () => {
    const d = draftFor(
      event({
        eventType: EVENT_TYPES.RISK_ASSESSED,
        payload: { ...risky, demurrage_probability: DEMURRAGE_PROBABILITY_URGENT },
      })
    )!;
    expect(d.severity).toBe("urgent");
  });

  // The rule that matters most. A simulation the system itself will not stand
  // behind (mock AIS, unresolved congestion) must never tell someone to
  // re-plan a voyage — see provenance.ts.
  test("stays silent when the simulation is not decision-grade", () => {
    expect(
      draftFor(
        event({
          eventType: EVENT_TYPES.RISK_ASSESSED,
          payload: { ...risky, decision_grade: false, demurrage_probability: 0.99 },
        })
      )
    ).toBeNull();
  });

  test("stays silent below the threshold", () => {
    expect(
      draftFor(
        event({
          eventType: EVENT_TYPES.RISK_ASSESSED,
          payload: { ...risky, demurrage_probability: DEMURRAGE_PROBABILITY_ALERT - 0.001 },
        })
      )
    ).toBeNull();
  });

  test("fires exactly at the threshold, not just above it", () => {
    expect(
      draftFor(
        event({
          eventType: EVENT_TYPES.RISK_ASSESSED,
          payload: { ...risky, demurrage_probability: DEMURRAGE_PROBABILITY_ALERT },
        })
      )
    ).not.toBeNull();
  });

  test("handles an event emitted before p90 was carried", () => {
    const d = draftFor(
      event({
        eventType: EVENT_TYPES.RISK_ASSESSED,
        payload: { ...risky, p90_exposure: undefined },
      })
    )!;
    expect(d).not.toBeNull();
    expect(d.body).not.toContain("NaN");
    expect(d.body).not.toContain("P90");
  });
});

describe("silence is the default", () => {
  // An inbox that receives every machine event is one nobody reads, at which
  // point the notifications that DO matter are lost with them.
  test.each([EVENT_TYPES.CLAIM_RECOMPUTED, EVENT_TYPES.SETTLEMENT_CHANGED, "something.new"])(
    "%s produces nothing",
    (eventType) => {
      expect(draftFor(event({ eventType, payload: { claim_id: CLAIM } }))).toBeNull();
    }
  );
});

describe("dedupe keys", () => {
  test("are stable for the same event and distinct across events", () => {
    const a = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } })
    )!;
    const b = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } })
    )!;
    const c = draftFor(
      event({
        eventType: EVENT_TYPES.SETTLEMENT_READY,
        idempotencyKey: "k2",
        payload: { claim_id: CLAIM },
      })
    )!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).not.toBe(c.dedupeKey);
  });

  test("carry the kind, so two rules on one event cannot collide", () => {
    const d = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } })
    )!;
    expect(d.dedupeKey.startsWith(`${NOTIFICATION_KINDS.CLAIM_AGREED}:`)).toBe(true);
  });
});

describe("capability routing, not role matching", () => {
  // The bug this design avoids: naming `finance_manager` literally would
  // exclude admins, who outrank them — and in a small tenant where the admin is
  // the finance manager, would deliver to nobody.
  test("every drafted capability includes admin among its recipients", () => {
    const drafts = [
      draftFor(event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } }))!,
      draftFor(
        event({
          eventType: EVENT_TYPES.NEGOTIATION_COMPLETED,
          payload: { claim_id: CLAIM, room_id: "r" },
        })
      )!,
    ];
    for (const d of drafts) {
      expect(recipients(d.capability)).toContain("admin");
    }
  });

  test("a viewer receives nothing, because a viewer can act on nothing", () => {
    const d = draftFor(
      event({ eventType: EVENT_TYPES.SETTLEMENT_READY, payload: { claim_id: CLAIM } })
    )!;
    expect(recipients(d.capability)).not.toContain("viewer");
  });
});
