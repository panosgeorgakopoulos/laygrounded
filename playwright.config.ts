// Playwright, configured to run against a real local dev server.
//
// WHY THIS EXISTS ALONGSIDE `bun test`. The unit suite covers pure logic, and
// covers it well — 2,724 tests. What it cannot cover is the browser: native
// `confirm()` and `prompt()` dialogs, file inputs, navigation, and the moment a
// component's assumption about an API's shape turns out to be wrong. Two of the
// last three phases found real defects only by looking at a rendered page
// (`undefined NaN` in a money field, a conformance root from the wrong rule
// set), and both would have been caught here.
//
// SERIAL, ONE WORKER, ON PURPOSE. The golden path mutates one shared demo
// tenant: it creates a claim, disputes an event, issues a grant. Parallel
// workers would race on that tenant and produce failures that look like product
// bugs. E2E speed is not worth a suite nobody trusts.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Passed through to `dev:e2e`, which reads it.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // A generous per-test budget: the golden path waits on real extraction and a
  // real engine run, and a flaky timeout is worse than a slow suite.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  fullyParallel: false,
  workers: 1,
  // Never in CI. A retry that passes hides a race, and a race in a money
  // workflow is exactly the thing worth failing on.
  retries: 0,

  // `forbidOnly` in CI: a stray `.only` silently reduces the suite to one test
  // while still reporting green.
  forbidOnly: Boolean(process.env.CI),

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    // Kept only for failures — a trace per passing test is gigabytes nobody reads.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Playwright starts the app itself, so `bun run test:e2e` needs no setup.
  // `reuseExistingServer` off in CI: a stale server from a previous job would
  // test the wrong build, which is the failure mode where a green suite means
  // nothing at all.
  webServer: {
    // `dev:e2e` rather than `dev`: the latter hardcodes -p 3000 and pipes
    // through tee, so a port flag never reaches Next — and a developer's own
    // dev server would collide with the run.
    command: "bun run dev:e2e",
    url: `${BASE_URL}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // The golden path loads a dozen-panel workspace four times over, which
      // clears the proxy's 100-req/min per-IP anti-flood bucket from a single
      // browser. The resulting 429 surfaced as "Claim not found" — a product
      // bug that was not one. Honoured only outside production; see src/proxy.ts.
      E2E_DISABLE_RATE_LIMIT: "1",
    },
  },
});
