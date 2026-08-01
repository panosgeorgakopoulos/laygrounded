/// <reference types="bun-types" />
// The negotiation phase is DERIVED, and this is why that matters.
//
// `claims.status` could not hold it: `recompute-server.ts` overwrites status on
// every calculation, so a workflow value parked there would survive until the
// next recompute and then vanish with no error anywhere — the claim would leave
// negotiation because somebody edited an event.
//
// Deriving it from facts also removes the second failure mode, which is worse:
// a stored label that disagrees with reality. A claim with live disputes must
// never read as anything but negotiating, whatever a flag says.

import { describe, expect, test } from "bun:test";
import { derivePhase } from "@/app/api/claims/[claimId]/negotiation/route";

const OPEN = { agreed_at: null, negotiation_opened_at: null };
const OPENED = { agreed_at: null, negotiation_opened_at: "2026-08-01T00:00:00Z" };
const AGREED = { agreed_at: "2026-08-02T00:00:00Z", negotiation_opened_at: "2026-08-01T00:00:00Z" };

describe("phase derivation", () => {
  test("a claim nobody has disputed is open", () => {
    expect(derivePhase(OPEN, 0)).toBe("open");
  });

  test("explicitly opening negotiation is enough, with no disputes yet", () => {
    // Talks can begin before anyone itemises an objection.
    expect(derivePhase(OPENED, 0)).toBe("negotiating");
  });

  test("A PENDING DISPUTE IS ENOUGH ON ITS OWN", () => {
    // The load-bearing case. If a dispute could exist while the claim read as
    // "open", the settlement gate would be reasoning about a claim somebody is
    // actively arguing about.
    expect(derivePhase(OPEN, 1)).toBe("negotiating");
  });

  test("agreement wins over everything", () => {
    expect(derivePhase(AGREED, 0)).toBe("agreed");
    // Even with a stray pending row: agreement is the terminal state, and the
    // POST route refuses to raise new disputes against an agreed claim.
    expect(derivePhase(AGREED, 3)).toBe("agreed");
  });

  test("resolving the last dispute returns an unopened claim to open", () => {
    expect(derivePhase(OPEN, 2)).toBe("negotiating");
    expect(derivePhase(OPEN, 0)).toBe("open");
  });

  test("an explicitly opened claim stays negotiating after disputes resolve", () => {
    // Closing is a deliberate act, not something that happens because the last
    // proposal was decided — talks may continue.
    expect(derivePhase(OPENED, 0)).toBe("negotiating");
  });
});
