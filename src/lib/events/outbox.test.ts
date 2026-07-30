import { describe, expect, test } from "bun:test";
import {
  EVENT_TYPES,
  MAX_ATTEMPTS,
  isDeadLettered,
  nextRetryDelayMs,
} from "@/lib/events/outbox";

describe("event type names", () => {
  test("every name is a past-tense fact matching the column CHECK", () => {
    // The DB enforces ^[a-z_]+\.[a-z_]+$; if these drift, inserts fail at
    // runtime inside a trigger, which aborts the state change that emitted it.
    for (const name of Object.values(EVENT_TYPES)) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  test("names are facts, not commands", () => {
    // A command has exactly one legitimate consumer, at which point the queue
    // is an RPC with worse failure modes. Guard the convention explicitly.
    const imperatives = ["recompute", "assess", "settle", "run", "send", "create"];
    for (const name of Object.values(EVENT_TYPES)) {
      const verb = name.split(".")[1];
      expect(imperatives).not.toContain(verb);
      expect(verb).toMatch(/(ed|changed)$/);
    }
  });
});

describe("retry policy", () => {
  test("backs off exponentially", () => {
    expect(nextRetryDelayMs(0)).toBe(1000);
    expect(nextRetryDelayMs(1)).toBe(2000);
    expect(nextRetryDelayMs(2)).toBe(4000);
    expect(nextRetryDelayMs(3)).toBe(8000);
  });

  test("stops rather than retrying a poison event forever", () => {
    // A poison event retried without limit is a denial-of-service against
    // every event queued behind it.
    expect(nextRetryDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextRetryDelayMs(MAX_ATTEMPTS + 5)).toBeNull();
  });

  test("dead-letters exactly at the threshold", () => {
    expect(isDeadLettered({ attempts: MAX_ATTEMPTS - 1 })).toBe(false);
    expect(isDeadLettered({ attempts: MAX_ATTEMPTS })).toBe(true);
  });

  test("honours a custom base delay", () => {
    expect(nextRetryDelayMs(0, 250)).toBe(250);
    expect(nextRetryDelayMs(3, 250)).toBe(2000);
  });

  test("the last delay before dead-lettering is bounded", () => {
    // 2^7 x 1s ≈ 2 minutes. Long enough to outlast a vendor blip, short enough
    // that a recovered consumer drains rather than crawls.
    const last = nextRetryDelayMs(MAX_ATTEMPTS - 1)!;
    expect(last).toBe(128_000);
    expect(last).toBeLessThan(10 * 60_000);
  });
});
