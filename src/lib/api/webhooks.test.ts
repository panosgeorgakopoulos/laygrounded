import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  eventForState,
  idempotencyKeyFor,
  isTimeBarEvent,
  signPayload,
  TIME_BAR_EVENTS,
} from "./webhooks";

describe("eventForState", () => {
  test("alerts only on the states worth waking an ERP for", () => {
    expect(eventForState("warning")).toBe("time_bar.warning");
    expect(eventForState("critical")).toBe("time_bar.critical");
    expect(eventForState("expired")).toBe("time_bar.expired");
  });

  test("'ok' and 'no_anchor' are the absence of news, not events", () => {
    expect(eventForState("ok")).toBeNull();
    expect(eventForState("no_anchor")).toBeNull();
  });
});

describe("isTimeBarEvent", () => {
  test("recognises exactly the published events", () => {
    for (const e of TIME_BAR_EVENTS) expect(isTimeBarEvent(e)).toBe(true);
    for (const bad of ["", "time_bar.ok", "*", "claim.created"]) {
      expect(isTimeBarEvent(bad)).toBe(false);
    }
  });
});

describe("idempotencyKeyFor", () => {
  // This is what makes alerts at-most-once per crossing rather than per
  // sweep: an hourly sweep re-deriving the same key hits the unique index
  // and delivers nothing.
  test("is stable for the same crossing", () => {
    const a = idempotencyKeyFor("c1", "time_bar.warning", "2026-07-30T10:00:00Z");
    const b = idempotencyKeyFor("c1", "time_bar.warning", "2026-07-30T10:00:00Z");
    expect(a).toBe(b);
  });

  test("differs when the claim, the band, or the deadline differs", () => {
    const base = idempotencyKeyFor("c1", "time_bar.warning", "2026-07-30T10:00:00Z");
    expect(idempotencyKeyFor("c2", "time_bar.warning", "2026-07-30T10:00:00Z")).not.toBe(base);
    // Crossing warning → critical is a new event, and must alert.
    expect(idempotencyKeyFor("c1", "time_bar.critical", "2026-07-30T10:00:00Z")).not.toBe(base);
    // A moved deadline means the voyage's events changed: alert again.
    expect(idempotencyKeyFor("c1", "time_bar.warning", "2026-08-01T10:00:00Z")).not.toBe(base);
  });
});

describe("signPayload", () => {
  const SECRET = "s3cret";

  test("is an HMAC-SHA256 of the raw body, prefixed sha256=", () => {
    const body = '{"event":"time_bar.warning"}';
    const expected = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(signPayload(body, SECRET)).toBe(expected);
    expect(signPayload(body, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("changes with the body and with the secret", () => {
    const a = signPayload("{}", SECRET);
    expect(signPayload("{ }", SECRET)).not.toBe(a);
    expect(signPayload("{}", "other")).not.toBe(a);
  });

  test("signs bytes, not a re-serialization — key order matters", () => {
    // The receiver verifies against the raw body it received, so signing must
    // depend on the exact string, not on a parsed object.
    expect(signPayload('{"a":1,"b":2}', SECRET)).not.toBe(signPayload('{"b":2,"a":1}', SECRET));
  });
});
