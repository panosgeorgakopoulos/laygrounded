// Shared sign-in for the E2E suite.
//
// Uses the seeded demo account rather than creating a user per run. Creating
// one would leave an auth record behind on every failure, and cleaning up auth
// users needs the service-role key inside the test process — a credential the
// browser suite has no business holding.

import { expect, type Page } from "@playwright/test";

// `||`, NOT `??`, and this is load-bearing in CI. GitHub Actions exports every
// key declared in a step's `env:` block, so a secret that does not exist
// arrives as the EMPTY STRING rather than as undefined. `??` only falls back on
// null/undefined, so it handed the empty string straight through: the suite
// typed nothing into the sign-in form, submission failed, and all seven tests
// died in `beforeEach` on a 30s `waitForURL` timeout — with test (a) failing
// first, so it read as "claim creation is broken" rather than "there is no
// password". `||` treats empty as absent, which is the only reading that makes
// sense for a credential.
export const DEMO_EMAIL = process.env.E2E_EMAIL || "demo2@laygrounded.com";
export const DEMO_PASSWORD = process.env.E2E_PASSWORD || "demo1234";

/**
 * The non-admin accounts seeded into the SAME tenant as the demo admin, by
 * `bun run seed:rbac` and by `POST /api/init-demo` on every run.
 *
 * They must share the tenant to be worth anything: an operator alone in a
 * company of their own passes every ownership check and would prove nothing
 * about the capability ladder. Their password is the shared demo one — these
 * are fixtures, not credentials.
 */
export const OPERATOR_EMAIL = "operator@laygrounded.com";
export const VIEWER_EMAIL = "viewer@laygrounded.com";
export const ROLE_ACCOUNT_PASSWORD = "demo1234";

/**
 * Signs in and waits for the app to be genuinely ready.
 *
 * Waits for the claims list rather than for the URL alone: the proxy redirects
 * on an auth cookie, so the URL changes before the session is usable, and a
 * test that raced ahead of it failed on the next click with an error that
 * looked like a product bug.
 *
 * Takes explicit credentials so the RBAC suite can sign in as an operator or a
 * viewer. Defaults to the demo admin, which is what the golden path wants.
 */
export async function signIn(
  page: Page,
  credentials: { email: string; password: string } = {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  }
): Promise<void> {
  await page.goto("/sign-in");

  // Already signed in from a previous test in the same worker. Only safe to
  // skip when it is the SAME account — the RBAC suite switches identity
  // mid-run, and reusing an admin session for an operator test would assert
  // the boundaries of the wrong role and pass for the wrong reason.
  if (page.url().includes("/claims") && (await signedInAs(page)) === credentials.email) {
    return;
  }

  // A session for somebody else must be cleared first, or Supabase restores it
  // from storage and the sign-in form is never shown.
  await signOut(page);
  await page.goto("/sign-in");

  await page.locator('input[type="email"]').fill(credentials.email);
  await page.locator('input[type="password"]').fill(credentials.password);
  await page.locator('button[type="submit"]').click();

  await page.waitForURL(/\/claims/, { timeout: 30_000 });

  // The claims TABLE, not a nav link. The island nav is a collapsing GSAP pill
  // whose links are not visible at rest, so waiting on one timed out even
  // though sign-in had fully succeeded — the check was reporting on the
  // navigation's animation state rather than on the session.
  await expect(page.getByRole("columnheader", { name: /vessel/i }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Who the browser is currently signed in as, or null.
 *
 * Asks `/api/me` rather than reading the page, because the email is not
 * rendered anywhere reliable and the question here is about the SESSION, not
 * about what happens to be on screen.
 */
export async function signedInAs(page: Page): Promise<string | null> {
  try {
    const res = await page.request.get("/api/me");
    if (!res.ok()) return null;
    const body = await res.json();
    return typeof body?.email === "string" ? body.email : null;
  } catch {
    return null;
  }
}

/**
 * Clears the Supabase session.
 *
 * Storage is cleared as well as cookies. Supabase persists the session in
 * localStorage and rehydrates from it on the next page load, so dropping only
 * the cookies leaves the client able to mint a fresh cookie for the OLD user —
 * which is how a role-switching suite silently runs half its assertions as the
 * previous account.
 */
export async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
  // Storage is origin-scoped, so it can only be cleared from a page ON that
  // origin. A blank tab has no origin and the call throws.
  try {
    await page.goto("/sign-in");
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
  } catch {
    // Nothing to clear — no page loaded yet. Harmless.
  }
}
