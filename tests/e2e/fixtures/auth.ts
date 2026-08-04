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
 * Signs in and waits for the app to be genuinely ready.
 *
 * Waits for the claims list rather than for the URL alone: the proxy redirects
 * on an auth cookie, so the URL changes before the session is usable, and a
 * test that raced ahead of it failed on the next click with an error that
 * looked like a product bug.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");

  // Already signed in from a previous test in the same worker.
  if (page.url().includes("/claims")) return;

  await page.locator('input[type="email"]').fill(DEMO_EMAIL);
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
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
