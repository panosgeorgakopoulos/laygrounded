// The RBAC boundaries, in a browser, as a non-admin.
//
// WHY THIS EXISTS ALONGSIDE THE UNIT SUITE. `roles.test.ts` proves the ladder
// is coherent and `route-guards.test.ts` proves the gated routes still carry a
// capability check — by reading the route files as text. Neither runs a
// request. Both would stay green if `assertCapability` were called with the
// wrong capability, if a panel rendered a button the server would refuse, or if
// `apiError` turned a FORBIDDEN throw into an opaque 500 (which is exactly what
// four routes did before Phase 14).
//
// And the golden path runs entirely as an admin, so every capability check in
// it passes. The interesting half of an authorisation model is the refusals,
// and until now not one of them was exercised end to end.
//
// WHAT A PASS HERE MEANS: the operator is refused by the SERVER, and the UI
// does not offer them the thing they would be refused for. Those are two
// separate assertions on purpose. Hiding a control is courtesy; the refusal is
// the security — and a suite that only checked the hiding would pass happily on
// a build whose API had stopped checking anything at all.
//
// READ-ONLY BY CONSTRUCTION. Unlike the golden path this spec creates nothing:
// every mutation it attempts is one it expects to be refused. If any of them
// ever succeeds, the assertion fails AND the tenant has been modified — which
// is precisely the alarm worth having.

import { test, expect, type Page } from "@playwright/test";
import {
  OPERATOR_EMAIL,
  ROLE_ACCOUNT_PASSWORD,
  VIEWER_EMAIL,
  signIn,
} from "./fixtures/auth";

const OPERATOR = { email: OPERATOR_EMAIL, password: ROLE_ACCOUNT_PASSWORD };
const VIEWER = { email: VIEWER_EMAIL, password: ROLE_ACCOUNT_PASSWORD };

/**
 * Any claim in the shared demo tenant.
 *
 * Taken from the API rather than by clicking a row: the assertions below are
 * about capabilities, not about the claims table, and a brittle row selector
 * would fail as though the permission model were broken. Ownership still holds
 * — the operator is in the same company — so a 403 here can only be about role.
 */
async function anyClaimId(page: Page): Promise<string> {
  const res = await page.request.get("/api/claims");
  expect(res.ok(), "the operator must be able to LIST claims — claim.read is a viewer capability").toBe(
    true
  );
  const body = await res.json();
  const claims = Array.isArray(body) ? body : (body.claims ?? []);
  expect(claims.length, "the demo tenant needs at least one claim; run `bun run seed:dataset`").toBeGreaterThan(0);
  return claims[0].id;
}

test.describe.configure({ mode: "serial" });

test.describe("RBAC boundaries — operator", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OPERATOR);
  });

  test("a. is signed in as an operator, not an admin", async ({ page }) => {
    // The premise of every other test in this file. Without it, a fixture
    // regression that silently signed in as the admin would turn this whole
    // spec green while asserting nothing — the failure mode a permissions
    // suite can least afford.
    const res = await page.request.get("/api/me");
    expect(res.ok()).toBe(true);
    const me = await res.json();

    expect(me.email).toBe(OPERATOR_EMAIL);
    expect(me.role).toBe("operator");
    expect(me.capabilities).toContain("claim.write");
    expect(me.capabilities).not.toContain("finance.grant");
    expect(me.capabilities).not.toContain("claim.agree");
    expect(me.capabilities).not.toContain("team.manage");
  });

  test("b. can do the operator's actual job", async ({ page }) => {
    // The other half of a permission boundary, and the half that is usually
    // missing: a model that refuses everything is not secure, it is broken.
    await page.goto("/claims");
    await expect(page.getByRole("columnheader", { name: /vessel/i }).first()).toBeVisible();

    // `claim.write` is theirs, so the route into creating one must be offered.
    await page.goto("/claims/new");
    await expect(page.getByLabel(/vessel name/i)).toBeVisible({ timeout: 20_000 });
  });

  test("c. team settings render read-only, with no invite form", async ({ page }) => {
    await page.goto("/settings/team");

    // The page itself is NOT forbidden — knowing who your colleagues are is a
    // viewer capability, and hiding the roster would make "why can't I click
    // this?" unanswerable without a support ticket.
    await expect(page.getByText(/you are signed in as/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/only an admin can invite people/i)).toBeVisible();

    // `team.manage` controls must be absent.
    await expect(page.getByRole("button", { name: /send invite/i })).toHaveCount(0);
    await expect(page.getByPlaceholder(/captain@fleet.com/i)).toHaveCount(0);
    // No role dropdowns and no remove buttons on the roster.
    await expect(page.getByRole("combobox", { name: /^role for /i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^remove /i })).toHaveCount(0);

    // The capability grid still renders — it is documentation, and it is what
    // tells an operator which colleague to ask.
    await expect(page.getByText(/what each role can do/i)).toBeVisible();
  });

  test("d. the workspace hides the money controls", async ({ page }) => {
    const claimId = await anyClaimId(page);
    await page.goto(`/claims/${claimId}/workspace`);

    // Wait for the workspace to actually settle. `useCan()` returns false while
    // /api/me is in flight, so asserting absence too early passes for the wrong
    // reason — every gated control is "hidden" during the first paint whatever
    // the role is. This is the single most important line in the file.
    await expect(page.getByRole("region", { name: /bank and auditor access/i })).toBeVisible({
      timeout: 30_000,
    });

    // finance.grant — issuing a bank credential.
    await expect(page.getByRole("button", { name: /issue access token/i })).toHaveCount(0);

    // claim.agree — fixing the figures. Either absent or disabled is a correct
    // outcome; what must never happen is an enabled button that 403s on click.
    const agree = page.getByRole("button", { name: /agree this claim/i });
    if ((await agree.count()) > 0) {
      await expect(agree.first()).toBeDisabled();
    }

    // claim.negotiate — a concession mandate is denominated in money.
    const runNegotiation = page.getByRole("button", { name: /run negotiation/i });
    if ((await runNegotiation.count()) > 0) {
      await expect(runNegotiation.first()).toBeDisabled();
    }
  });

  // ── The server-side half ────────────────────────────────────────────────
  //
  // `page.request` shares the browser context's cookies, so these are the
  // operator's real session hitting the real routes. This is the part that
  // would catch a UI correctly hiding a button in front of an API that had
  // stopped checking — the failure a UI-only assertion is blind to.

  test("e. the API refuses every capability the operator lacks", async ({ page }) => {
    const claimId = await anyClaimId(page);

    const refusals: Array<{ what: string; send: () => Promise<{ status: number; body: unknown }> }> = [
      {
        what: "finance.grant — issue a bank credential",
        send: async () => {
          const res = await page.request.post(`/api/claims/${claimId}/finance-grants`, {
            data: { institution: "E2E RBAC Bank", scope: "verify" },
          });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
      {
        what: "claim.agree — fix the figures",
        send: async () => {
          const res = await page.request.post(`/api/claims/${claimId}/agree`, { data: {} });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
      {
        what: "claim.settle — build a payment instruction",
        send: async () => {
          const res = await page.request.post(`/api/claims/${claimId}/settle`, { data: {} });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
      {
        // PUT, not POST — this route upserts. Worth stating because the first
        // draft of this test sent a POST and got a 405, which is Next's "no
        // such handler" and would have passed a laxer assertion than `toBe(403)`
        // while proving nothing about the capability at all.
        what: "finance.counterparty — choose the account a settlement pays into",
        send: async () => {
          const res = await page.request.put("/api/settlement/counterparty-finance", {
            // Deliberately minimal: the capability check runs BEFORE the body is
            // parsed, so a refusal here cannot be a validation error wearing the
            // wrong status.
            data: {},
          });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
      {
        what: "finance.counterparty — choose the escrow contract for an on-chain leg",
        send: async () => {
          const res = await page.request.put("/api/settlement/chain-configs", { data: {} });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
      {
        what: "team.manage — invite a colleague",
        send: async () => {
          const res = await page.request.post("/api/settings/members", {
            data: { email: "e2e-should-never-exist@laygrounded.com", role: "admin" },
          });
          return { status: res.status(), body: await res.json().catch(() => null) };
        },
      },
    ];

    for (const refusal of refusals) {
      const { status, body } = await refusal.send();

      // 403 EXACTLY, and this is the assertion with teeth. A 500 means the
      // FORBIDDEN throw escaped `apiError()` and became an opaque server fault
      // — the route is still refusing, but nothing downstream can tell a
      // permission boundary from a crash, and the caller is invited to retry.
      // A 401 would mean the session broke and the test proved nothing about
      // roles at all.
      expect(status, `${refusal.what} must be refused with 403, got ${status}`).toBe(403);
      expect(
        (body as { error?: string } | null)?.error,
        `${refusal.what} must name FORBIDDEN so the client can explain it`
      ).toBe("FORBIDDEN");
    }
  });

  test("f. a refused capability does not confirm a stranger's claim id", async ({ page }) => {
    // The ordering rule from `claim-access.ts`: the capability check sits AFTER
    // the ownership check, so a 403 never doubles as "this id is real". A claim
    // id from another tenant must be indistinguishable from one that does not
    // exist — both 404, never 403.
    const foreignClaimId = "00000000-0000-4000-8000-000000000000";
    const res = await page.request.post(`/api/claims/${foreignClaimId}/finance-grants`, {
      data: { institution: "E2E RBAC Bank", scope: "verify" },
    });

    expect(
      res.status(),
      "an unknown claim must 404 before the capability check, or a 403 leaks that the id exists"
    ).toBe(404);
  });
});

test.describe("RBAC boundaries — viewer", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, VIEWER);
  });

  test("g. a viewer may read but not write", async ({ page }) => {
    const me = await (await page.request.get("/api/me")).json();
    expect(me.email).toBe(VIEWER_EMAIL);
    expect(me.role).toBe("viewer");
    expect(me.capabilities).toEqual(["claim.read"]);

    // Reading is the whole point of the role, so it must genuinely work.
    await page.goto("/claims");
    await expect(page.getByRole("columnheader", { name: /vessel/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    // `claim.write` is what makes `viewer` mean anything. Without this
    // assertion the role is indistinguishable from an operator in practice.
    const res = await page.request.post("/api/claims", {
      data: { vessel: "E2E VIEWER SHOULD NEVER EXIST", voyage: "E2E-DENY" },
    });
    expect(res.status(), "a viewer creating a claim must be refused").toBe(403);
    expect((await res.json().catch(() => null))?.error).toBe("FORBIDDEN");
  });

  test("h. the viewer is not offered the claim-writing controls", async ({ page }) => {
    await page.goto("/claims");
    await expect(page.getByRole("columnheader", { name: /vessel/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    // The server refusal above is the security. This is the courtesy half: a
    // viewer should not be walked into a form that cannot be submitted.
    //
    // Both of these were ungated until this suite went looking. "Seed Demo
    // Scenarios" was the worse of the two — it posted to a route that had no
    // capability check at all, so the button worked.
    await expect(page.getByRole("button", { name: /create claim workspace/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /seed demo scenarios/i })).toHaveCount(0);
  });

  test("i. the seed route refuses a viewer", async ({ page }) => {
    // The route beneath the button that used to be ungated. Asserted directly,
    // because the button being hidden proves nothing about the endpoint — and
    // the endpoint is what a viewer with a browser console would reach for.
    const res = await page.request.post("/api/seed", { data: {} });
    expect(res.status(), "a viewer seeding demo claims must be refused").toBe(403);
    expect((await res.json().catch(() => null))?.error).toBe("FORBIDDEN");
  });
});
