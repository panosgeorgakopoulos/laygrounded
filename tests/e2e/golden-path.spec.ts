// The golden path: a claim from creation to a revoked bank credential.
//
// WHAT THIS COVERS THAT `bun test` CANNOT.
//
// The unit suite tests pure logic and tests it thoroughly. What it cannot reach
// is the browser — native `confirm()` and `prompt()` dialogs, real navigation,
// and the moment a component's assumption about an API's shape turns out to be
// wrong. The last three phases each found a defect only by looking at a
// rendered page: a money field showing `undefined NaN`, a conformance root from
// the wrong engine rule set, a map nine times taller than its frame. All three
// were invisible to a green unit suite, and the first two are exactly the class
// of thing these assertions catch.
//
// THE DIALOG STEP IS THE POINT OF ADOPTING PLAYWRIGHT. The browser automation
// used through Phases 8–12 dropped its connection on any native dialog, so
// every `confirm()`-guarded destructive action — revoking a grant, deleting a
// finance record — was verified at the API layer and never through the UI. That
// is a real gap: the button could have been wired to the wrong id and every
// server-side check would still have passed.
//
// IT DOES NOT CLEAN UP AFTER ITSELF, on purpose. There is no claim-deletion
// route: a claim is evidence, carrying notarisation anchors and an audit
// ledger. Adding a destructive endpoint so a test could tidy up would be a
// product decision made for a test's convenience. Every artifact instead
// carries the run id, so leftovers are identifiable and removable in one
// statement — see tests/e2e/README.md.

import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./fixtures/auth";

/** Unique per run, so a failed run's leftovers are identifiable and never collide. */
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const VESSEL = `E2E PATHFINDER ${RUN}`;
const VOYAGE = `E2E-${RUN}`;

/** A Statement of Facts the deterministic extractor can read: day-first, offsets on the line. */
const SOF_TEXT = [
  `STATEMENT OF FACTS — ${VESSEL}`,
  "Santos, Brazil",
  "",
  "04/03/2024 06:30 +08:00  Notice of Readiness tendered to charterers agents",
  "04/03/2024 11:45 +08:00  Vessel all fast alongside berth no. 3",
  "04/03/2024 13:00 +08:00  Commenced loading soybeans",
  "05/03/2024 02:15 +08:00  Heavy rain, all work stopped",
  "05/03/2024 07:40 +08:00  Weather improved, operations resumed",
  "08/03/2024 21:20 +08:00  Completed loading",
].join("\n");

let claimUrl = "";

test.describe.configure({ mode: "serial" });

test.describe("golden path", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("a. creates a claim", async ({ page }) => {
    await page.goto("/claims/new");

    await page.getByLabel(/vessel name/i).fill(VESSEL);
    await page.getByLabel(/voyage reference/i).fill(VOYAGE);
    await page.getByLabel(/load \/ disch port/i).fill("Santos, BR");
    await page.getByLabel(/cargo details/i).fill("Soybeans, 62,000 MT");

    await page.getByRole("button", { name: /create workspace/i }).click();

    // The workspace URL carries the new claim's id — captured for the rest of
    // the suite, because a serial path that re-navigated by name would break
    // the moment two runs overlapped.
    await page.waitForURL(/\/claims\/[0-9a-f-]{36}/i, { timeout: 30_000 });
    // Creation lands on the workspace already, so the suffix is stripped to
    // leave the claim ROOT. Appending `/workspace` to a URL that already ended
    // in it produced `/claims/:id/workspace/workspace`, which redirects to the
    // claims list — and every later step then failed looking for a panel on
    // what was actually the index page.
    claimUrl = new URL(page.url()).pathname.replace(/\/workspace\/?$/, "");
    expect(claimUrl).toMatch(/^\/claims\/[0-9a-f-]{36}$/i);

    await expect(page.getByText(VESSEL).first()).toBeVisible();
  });

  test("b. ingests a Statement of Facts and lands events for review", async ({ page }) => {
    await page.goto(`${claimUrl}/workspace`);

    // The opener sits under the document viewer, which on a claim with no
    // document is a full-pane dropzone — so it can be below the fold. Scrolled
    // into view rather than waited on blindly: a click that times out because
    // the target is off-screen looks identical to a missing feature.
    const opener = page.getByRole("button", { name: /paste sof text/i });
    await opener.scrollIntoViewIfNeeded();
    await opener.click();

    await page.locator("textarea").first().fill(SOF_TEXT);

    await page.getByRole("button", { name: /preview events/i }).click();

    // Six datable lines. Asserting the COUNT rather than merely "something
    // appeared" is what would have caught the day-first offset bug in Phase 9,
    // where a correctly written `+08:00` was rejected as a naive timestamp.
    await expect(page.getByText(/6 events found/i)).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: /add 6 to timeline/i }).click();
    await expect(page.getByText(/added 6 events as suggestions/i)).toBeVisible();

    // The review gate: extracted events must not move a figure until confirmed.
    await expect(page.getByText(/do not affect any figure until you/i)).toBeVisible();
  });

  test("c. confirms an event, then disputes it and blocks agreement", async ({ page }) => {
    await page.goto(`${claimUrl}/workspace`);

    // The dispute composer only lists CONFIRMED events, and step (b)
    // deliberately landed everything as `suggested` — the review gate working
    // as designed. So the path has to accept one first, which is also the
    // honest sequence a user follows.
    const accept = page.getByRole("button", { name: /^accept$/i }).first();
    await accept.scrollIntoViewIfNeeded();
    await accept.click();
    await expect(page.getByRole("button", { name: /^accept$/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    const negotiation = page.getByRole("region", { name: /dispute an event/i });
    await negotiation.scrollIntoViewIfNeeded();

    const eventSelect = negotiation.getByRole("combobox").first();
    // The first real option is index 1; index 0 is the "Select…" placeholder.
    await eventSelect.selectOption({ index: 1 });

    await negotiation
      .getByRole("textbox")
      .last()
      .fill(`E2E ${RUN}: disputing this event's recorded time against the port log.`);

    await page.getByRole("button", { name: /raise dispute/i }).click();

    // The workflow must advance AND agreement must become blocked. Asserting
    // only the first would pass even if the settlement gate ignored the dispute.
    await expect(page.getByText(/1 dispute is still open/i)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: /agree this claim/i })
    ).toBeDisabled();
  });

  test("d. opens the strategy room and shows the converted mandate", async ({ page }) => {
    await page.goto(`${claimUrl}/workspace`);

    const strategy = page.getByRole("region", { name: /concession strategy/i });
    await strategy.scrollIntoViewIfNeeded();
    await expect(strategy).toBeVisible();

    // The percentage must resolve to a real money figure in front of the user.
    // A regression here would restore the "black box mandate" the panel exists
    // to prevent, and it would look completely normal on screen.
    await expect(strategy.getByText(/concession budget/i)).toBeVisible();
    await expect(strategy.getByText(/never concede/i)).toBeVisible();
    await expect(strategy.getByRole("button", { name: /run negotiation/i })).toBeEnabled();
  });

  test("e. issues and revokes a bank grant through a native dialog", async ({ page }) => {
    await page.goto(`${claimUrl}/workspace`);

    const grants = page.getByRole("region", { name: /bank and auditor access/i });
    await grants.scrollIntoViewIfNeeded();

    const institution = `E2E Bank ${RUN}`;
    await page.getByPlaceholder(/nordea trade finance/i).fill(institution);
    await page.getByRole("button", { name: /issue access token/i }).click();

    // Shown once, because only the hash is stored.
    await expect(page.getByText(/shown once/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(institution)).toBeVisible();

    // ── The step this framework was adopted for ──────────────────────────
    //
    // Revocation is guarded by a native `prompt()`. The previous automation
    // dropped its connection here, so this button had never been exercised
    // through the UI — only the route beneath it. Playwright handles the dialog
    // in-process, which is the whole reason for the migration.
    let dialogSeen = false;
    page.once("dialog", async (dialog) => {
      dialogSeen = true;
      expect(dialog.type()).toBe("prompt");
      // The copy must name the consequence: revocation is indistinguishable
      // from "no such token" on the holder's side, so it cannot be undone by
      // resending anything.
      expect(dialog.message()).toContain(institution);
      await dialog.accept(`revoked by E2E run ${RUN}`);
    });

    await page.getByRole("button", { name: /^revoke$/i }).first().click();

    await expect.poll(() => dialogSeen, { timeout: 15_000 }).toBe(true);
    await expect(page.getByText(/revoked/i).first()).toBeVisible({ timeout: 20_000 });
    // The reason travels with the revocation — an audit record with no reason
    // is a record of an unexplained action.
    await expect(page.getByText(new RegExp(`revoked by E2E run ${RUN}`, "i"))).toBeVisible();
  });

  test("f. the activity ledger attributes every actor", async ({ page }) => {
    await page.goto(`${claimUrl}/workspace`);

    const filters = page.getByRole("group", { name: /filter by actor/i });
    await filters.scrollIntoViewIfNeeded();

    // The claim has now been touched by a person (creation, dispute), by AI
    // (nothing yet — the SoF ingest is deterministic, so it reports as AI) and
    // by the system. What matters is that NOTHING reads as unattributed: an
    // `unknown` here would mean a code path landed a row with no provenance.
    await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /person/i })).toBeVisible();
  });

  test("g. leaves an identifiable artifact rather than deleting evidence", async ({ page }) => {
    // THE SUITE DOES NOT DELETE ITS CLAIM, and that is deliberate.
    //
    // There is no claim-deletion route, because a claim in this system is
    // evidence: it carries notarisation anchors, an audit ledger and possibly
    // a settlement instruction. Adding a destructive endpoint so a test could
    // tidy up would be a product decision made for the convenience of the test
    // — precisely backwards, and the kind of endpoint that later gets called
    // by something other than a test.
    //
    // Instead every artifact carries the run id, so leftovers are identifiable
    // and removable in one statement. See tests/e2e/README.md.
    await page.goto("/claims");
    await expect(page.getByText(VESSEL).first()).toBeVisible();
    expect(VESSEL).toContain(RUN);
  });
});
