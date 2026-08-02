/// <reference types="bun-types" />
// The claim ledger.
//
// The property that matters most is NEGATIVE: the projection must never invent
// an actor. An audit trail that attributes a machine's action to a person is
// worse than no audit trail, because somebody will rely on it.

import { describe, expect, test } from "bun:test";
import {
  actorForEventSource,
  buildClaimActivity,
  type ActivitySources,
} from "./claim-activity";

const EMPTY: ActivitySources = {
  claim: {
    created_at: "2026-03-01T00:00:00Z",
    agreed_at: null,
    negotiation_opened_at: null,
    settled_at: null,
    settled_amount: null,
    engine_version: 2,
    external_source: null,
  },
  currency: "USD",
  events: [],
  proposals: [],
  calculation: null,
  evidence: [],
  lineage: [],
  domainEvents: [],
  notarizations: [],
  negotiations: [],
  settlements: [],
  drafts: [],
};

describe("actor attribution", () => {
  test("a manual entry is a person", () => {
    expect(actorForEventSource("manual")).toBe("human");
  });

  test("extraction is AI, not a person", () => {
    expect(actorForEventSource("ai")).toBe("ai");
    expect(actorForEventSource("multimodal")).toBe("ai");
  });

  test("another system is external", () => {
    expect(actorForEventSource("erp")).toBe("external");
    expect(actorForEventSource("chain")).toBe("external");
  });

  test("AN UNRECOGNISED SOURCE IS `unknown`, NEVER A PERSON", () => {
    // The load-bearing case. Defaulting to "human" would put a name on a
    // machine's action in a document somebody audits.
    expect(actorForEventSource(null)).toBe("unknown");
    expect(actorForEventSource("some_future_source")).toBe("unknown");
    expect(actorForEventSource("")).toBe("unknown");
  });
});

describe("ordering and dating", () => {
  test("newest first", () => {
    const out = buildClaimActivity({
      ...EMPTY,
      claim: { ...EMPTY.claim, agreed_at: "2026-03-05T00:00:00Z" },
    });
    expect(out[0].id).toBe("claim-agreed");
    expect(out[out.length - 1].id).toBe("claim-created");
  });

  test("an undated fact is DROPPED, not dated now", () => {
    // Placed at `now` it would read as the most recent thing that happened.
    const out = buildClaimActivity({
      ...EMPTY,
      evidence: [
        { id: "e1", check_type: "weather", verdict: "corroborated", summary: null, checked_at: null },
      ],
    });
    expect(out.some((x) => x.id === "evidence-e1")).toBe(false);
  });

  test("a malformed timestamp is dropped too", () => {
    const out = buildClaimActivity({
      ...EMPTY,
      settlements: [
        { id: "s1", settlement_ref: "REF", ready: true, created_at: "not-a-date" },
      ],
    });
    expect(out.some((x) => x.id === "settlement-s1")).toBe(false);
  });
});

describe("what each entry claims", () => {
  test("the engine is system, and names the rule set", () => {
    const [entry] = buildClaimActivity({
      ...EMPTY,
      calculation: {
        computed_at: "2026-03-04T00:00:00Z",
        used_hours: 122,
        demurrage_amount: 58333.33,
        despatch_amount: 0,
        currency: "USD",
      },
    });
    expect(entry.actorKind).toBe("system");
    expect(entry.actorLabel).toContain("v2");
    expect(entry.amount).toEqual({ value: 58333.33, currency: "USD" });
  });

  test("the autonomous negotiator is AI and says nothing settled automatically", () => {
    const [entry] = buildClaimActivity({
      ...EMPTY,
      negotiations: [
        {
          id: "r1",
          agent_rounds_completed: 4,
          final_settlement_probability: 0.41,
          settlement_matrix: { recommendedSettlement: 46667, currency: "USD" },
          created_at: "2026-03-06T00:00:00Z",
        },
      ],
    });
    expect(entry.actorKind).toBe("ai");
    expect(entry.amount?.value).toBe(46667);
    expect(entry.detail).toContain("nothing settled automatically");
  });

  test("a guest proposal is external; an internal one is human", () => {
    const out = buildClaimActivity({
      ...EMPTY,
      proposals: [
        {
          id: "p1",
          action: "amend",
          status: "pending",
          note: "n",
          proposed_by_label: "Charterer",
          share_id: "share-1",
          created_at: "2026-03-02T00:00:00Z",
          decided_at: null,
        },
        {
          id: "p2",
          action: "amend",
          status: "pending",
          note: "n",
          proposed_by_label: "Us",
          share_id: null,
          created_at: "2026-03-03T00:00:00Z",
          decided_at: null,
        },
      ],
    });
    expect(out.find((e) => e.id === "proposal-p1")?.actorKind).toBe("external");
    expect(out.find((e) => e.id === "proposal-p2")?.actorKind).toBe("human");
  });

  test("raising and deciding a dispute are two entries", () => {
    const out = buildClaimActivity({
      ...EMPTY,
      proposals: [
        {
          id: "p1",
          action: "amend",
          status: "accepted",
          note: "n",
          proposed_by_label: "Us",
          share_id: null,
          created_at: "2026-03-02T00:00:00Z",
          decided_at: "2026-03-03T00:00:00Z",
        },
      ],
    });
    expect(out.filter((e) => e.id.startsWith("proposal")).length).toBe(2);
  });

  test("a claim created from an ERP is attributed to the ERP, not a user", () => {
    const [entry] = buildClaimActivity({
      ...EMPTY,
      claim: { ...EMPTY.claim, external_source: "DANAOS" },
    });
    expect(entry.actorKind).toBe("external");
    expect(entry.summary).toContain("DANAOS");
  });

  test("ids are unique, so the list can be keyed safely", () => {
    const out = buildClaimActivity({
      ...EMPTY,
      events: [
        { id: "a", event_type: "NOR_TENDERED", occurred_at: "2026-03-01T06:00:00Z", created_at: "2026-03-01T07:00:00Z", source: "ai", status: "accepted" },
        { id: "b", event_type: "ALL_FAST", occurred_at: "2026-03-01T08:00:00Z", created_at: "2026-03-01T09:00:00Z", source: "manual", status: "accepted" },
      ],
    });
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
  });
});
