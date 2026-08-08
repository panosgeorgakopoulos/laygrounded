// Static audit: the sensitive routes actually carry their capability gate.
//
// WHY THIS IS A TEST AND NOT A CODE REVIEW ITEM. The RBAC model is only worth
// as much as its weakest call site. Nothing about `POST /api/claims/:id/agree`
// makes it *look* different from a dozen unguarded routes, so a guard removed
// during an unrelated refactor — or simply never added to a new money route —
// leaves no trace: the route still compiles, still passes its own tests, and
// still returns 200 to a viewer.
//
// String analysis over the route files, in the same spirit as
// `check-orphaned-routes.ts` and `definer-grants.ts`. It proves the gate is
// PRESENT, not that it is correctly placed — the ordering rule (capability
// after ownership, so a 403 cannot confirm a stranger's claim id) is documented
// in `claim-access.ts` and is a review question. Presence is the part that
// regresses silently.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_MIN_ROLE, type Capability } from "./roles";

const APP = join(import.meta.dir, "../../app");

/**
 * Every route that performs a gated act, and the capability it must check.
 *
 * Adding a money-moving or credential-issuing route means adding a line here.
 * That is the point: the list is the specification, and a route that belongs on
 * it but is missing is exactly what nobody notices.
 */
const GATED_ROUTES: Array<{ path: string; capability: Capability; why: string }> = [
  {
    path: "api/claims/[claimId]/agree/route.ts",
    capability: "claim.agree",
    why: "fixes the figures and releases the payment instruction",
  },
  {
    path: "api/claims/[claimId]/settle/route.ts",
    capability: "claim.settle",
    why: "clears funds through the banking provider",
  },
  {
    path: "api/claims/[claimId]/finance-grants/route.ts",
    capability: "finance.grant",
    why: "issues a bank a credential to this claim",
  },
  {
    path: "api/claims/[claimId]/finance-grants/[grantId]/route.ts",
    capability: "finance.grant",
    why: "revocation is irreversible from the holder's side",
  },
  {
    path: "api/settlement/counterparty-finance/route.ts",
    capability: "finance.counterparty",
    why: "chooses the account a settlement pays into",
  },
  {
    path: "api/settlement/chain-configs/route.ts",
    capability: "finance.counterparty",
    why: "chooses the escrow contract that receives an on-chain leg",
  },
  {
    path: "api/v1/claims/[claimId]/negotiate/route.ts",
    capability: "claim.negotiate",
    why: "commits a concession budget denominated in money",
  },
  {
    path: "api/settings/members/route.ts",
    capability: "team.manage",
    why: "changes who holds which authority in the tenant",
  },
  // The claim.write set: what makes `viewer` mean anything at all.
  { path: "api/claims/route.ts", capability: "claim.write", why: "creates a claim" },
  {
    path: "api/seed/route.ts",
    capability: "claim.write",
    why: "writes three demo claims into the tenant — missed in Phase 14 because its idempotency guard made it a no-op on any tenant that already had claims, which is not an authorisation control",
  },
  { path: "api/claims/[claimId]/route.ts", capability: "claim.write", why: "edits a claim" },
  {
    path: "api/claims/[claimId]/events/route.ts",
    capability: "claim.write",
    why: "adds an event to the timeline",
  },
  {
    path: "api/claims/[claimId]/events/[eventId]/route.ts",
    capability: "claim.write",
    why: "edits a confirmed event",
  },
  {
    path: "api/claims/[claimId]/documents/route.ts",
    capability: "claim.write",
    why: "uploads a Statement of Facts",
  },
  {
    path: "api/claims/[claimId]/ingest-sof-text/route.ts",
    capability: "claim.write",
    why: "ingests a timeline from text",
  },
  {
    path: "api/claims/[claimId]/proposals/route.ts",
    capability: "claim.write",
    why: "raises a dispute against an event",
  },
];

/** A capability check, however the route spells it. */
function guardsWith(sql: string, capability: Capability): boolean {
  const stripped = sql.replace(/\/\/[^\n]*/g, "");
  const call = new RegExp(
    String.raw`(assertCapability|requireCapability|requireOwnedClaim)\s*\(` +
      String.raw`[^;]*?["']` +
      capability.replace(".", String.raw`\.`) +
      String.raw`["']`,
    "s"
  );
  return call.test(stripped);
}

describe("sensitive routes are gated", () => {
  test.each(GATED_ROUTES)("$path checks $capability ($why)", ({ path, capability }) => {
    const full = join(APP, path);
    // A renamed or deleted route must fail loudly rather than silently pass by
    // matching nothing — the classic way an allowlist-shaped test rots.
    expect({ path, exists: existsSync(full) }).toEqual({ path, exists: true });
    expect({ path, guarded: guardsWith(readFileSync(full, "utf8"), capability) }).toEqual({
      path,
      guarded: true,
    });
  });

  test("every capability in the model is exercised by at least one route", () => {
    const covered = new Set(GATED_ROUTES.map((r) => r.capability));
    const uncovered = (Object.keys(CAPABILITY_MIN_ROLE) as Capability[]).filter(
      // `claim.read` is the floor: every member holds it, so there is nothing to
      // gate. Any OTHER capability with no call site is a model that promises an
      // authority boundary the product does not actually enforce.
      (c) => c !== "claim.read" && !covered.has(c)
    );
    expect(uncovered).toEqual([]);
  });

  test("the gated routes surface FORBIDDEN as 403 rather than an opaque 500", () => {
    // apiError() maps the FORBIDDEN sentinel. A route with its own catch that
    // does not go through apiError would swallow the throw into a 500 — which is
    // how four of these routes behaved before Phase 14 wired them up.
    const missing = GATED_ROUTES.filter(({ path }) => {
      const src = readFileSync(join(APP, path), "utf8");
      return !src.includes("apiError(");
    }).map((r) => r.path);
    expect(missing).toEqual([]);
  });
});
