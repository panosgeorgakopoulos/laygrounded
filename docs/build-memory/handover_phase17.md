# Phases 14–17 — wrap-up, handover, and production-readiness

State of `main` after four phases shipped and merged in order: **RBAC (14)**,
**Notifications (15)**, **Onboarding & Invitations (16)**, **B2B Secure Sharing
& CSV Export (17)**, plus a post-merge **grant-hardening pass**.

Read with `handover_phase8.md` (engine rule sets, counterparty finance) and
`handover_phase7.md` (integrations, outbox, settlement payloads).

---

## 1. Read this first

Three rules from earlier handovers held again, and two more earned their place.

- **Audit before building.** Phase 17's directive asked for secure counterparty
  sharing with revocation. `resolveShare()`, revocation, expiry and the owner-side
  UI *already existed*. The honest deliverable was a read-only **mode** on proven
  token machinery, not the parallel `/share/claim/[token]` system the brief
  described — a second implementation is where the 404-vs-403 discipline breaks.
  This is the third phase in a row where the audit changed the shape of the work.
- **Judge applied-ness from the catalog.** Every migration in these phases was
  verified with `pg_proc.proacl` / `pg_policies` / `information_schema` *after*
  applying, and then probed live by setting `request.jwt.claims` and reading as
  each role.
- **Prefer an independent check.** Supabase's own security advisor found five
  SECURITY DEFINER functions reachable by `anon` that the repo's *own* guard
  (`security/definer-grants.ts`) had been green on for months. See §5.
- **NEW — a test that asserts only absence certifies nothing about presence.**
  The statement-view leakage suite is thorough and mutation-verified, and it sat
  green while the entire "Terms applied" block rendered as em-dashes, because
  the projection read invented `CpTerms` key names. Every field was `null`;
  nothing asserted a field was *populated*. Only looking at the rendered page
  caught it. **Pair every allowlist test with an exact-equality assertion on the
  happy path.**
- **NEW — an allowlist must be per-dimension.** `INTENTIONALLY_EXECUTABLE`
  exempted a function from the `anon` check *and* the `authenticated` check,
  while every written justification beside every entry only ever argued for
  `authenticated`. One coarse exemption, five functions left open to anon. See §5.

---

## 2. What these phases shipped

| Phase | Shipped | The load-bearing idea |
|---|---|---|
| 14 | RBAC: 4 ordered roles, capability model, team management | **Minimum role per capability**, not a set of roles — a non-monotonic grant is unrepresentable |
| 15 | Notification inbox, outbox fan-out, bell | Routed by **capability**, never by role name; silence is the default |
| 16 | Invitations as records, zero-to-tenant onboarding, RBAC E2E | An invitation is an **offer with a lifecycle**, not a membership row |
| 17 | Read-only counterparty statements, CSV export | A share token carries **what it grants**, enforced in the API |
| — | Grant hardening | Make the grant layer agree with the RLS layer |

---

## 3. Phase 16: the orphaned-company bug was in sign-up

Worth stating plainly because the symptom pointed elsewhere. The seed script was
blamed for orphaned companies; the cause was `SignUpForm` calling
`/api/bootstrap` for **everyone**, including invited users, who were then
bootstrapped into a company of their own and permanently refused by the
single-company rule.

Tenancy now gets decided at `/onboarding`, after authentication, where "has
anybody invited you" is knowable. `/api/bootstrap` **refuses while an invitation
is outstanding**, so a stale tab cannot reintroduce it.

**Two orphaned empty companies still exist in the database** (`demo@laygrounded.com`
and `demo@laygrounded.io`, 0 claims each) — artefacts of the bug, harmless, and
left in place rather than deleted without instruction.

### Two proofs of entitlement, deliberately unequal

`decideRedemption` takes a `RedemptionProof`:

- `"token"` — the emailed 256-bit secret. Self-proving; possession shows the
  message arrived.
- `"verified-email"` — the onboarding page, which lists invitations found by the
  reader's own address. Necessary because `inviteUserByEmail` **refuses an
  address that already has an account**, so for those invitees no token exists.
  This path additionally requires `email_confirmed_at`, or registering as
  `cfo@target.com` on a deployment without mandatory confirmation would hand
  over whatever was waiting.

**Do not collapse these into one path.**

---

## 4. Phase 17: two share modes, one token system

`claim_shares.access_mode` is `negotiate` (the claim room — counterparty
**writes** proposals) or `readonly` (the statement view — evidence only).
Defaults to `negotiate`: every pre-existing token was a room link whose holder
may have proposals in flight.

`resolveShareForMode()` returns null on a mismatch → **404, never 403**. A
readonly token at `/api/rooms/:token/proposals` is indistinguishable from a
token that never existed.

### The leakage guarantee

`buildStatementView` copies every field by name. `statement-view.test.ts` builds
a view from a claim row carrying every internal column in the schema plus
invented future ones and fails if any sentinel appears in the serialised
payload. **Mutation-verified**: injecting `...claim` makes it fail and name each
leaked field.

Never add: negotiation mandate/concession bounds, notifications, voyage alerts,
drafts, ERP refs, `settled_amount`, `time_bar_days`, `negotiation_opened_at`, or
any company/user identifier.

Charterparty terms **are** shared — the counterparty is party to that contract
and withholding them makes the statement unverifiable.

### CSV: formula injection is the threat, not escaping

`raw_text` is lifted verbatim from counterparty-supplied PDFs and Excel executes
cells beginning `=`, `+`, `-`, `@`, tab or CR. `neutralise()` **prefixes rather
than strips** — deleting the minus from `-1200 MT shortfall` corrupts evidence.
Numbers never pass through it. Timestamps export as ISO text, never spreadsheet
dates: Excel reinterprets `04/03/2024` in the opening machine's locale.

`export-csv.ts` is **not** `export.ts`. The latter builds the rendered PDF+XLSX
claim pack (`POST /api/claims/:id/export`) — a stored document set for attaching
to a submission. The former is raw tabular data for pivoting. Both are wanted.

---

## 5. The grant-hardening pass (post-merge)

Ran Supabase's security advisor against the live project, then checked each
finding in `pg_catalog` rather than trusting the lint.

**Two real findings, neither exploitable, both closed:**

1. **Seven service-role-only tables** (`oauth_access_tokens`,
   `oauth_refresh_tokens`, `oauth_authorization_codes`, `oauth_clients`,
   `public_tool_leads`, `public_tool_usage`, `api_rate_limits`) had full DML
   granted to `anon` and `authenticated` by Supabase's default privileges. RLS
   denied it — but that made the control one layer, not two, over live bearer
   credentials and lead PII. Revoked.
2. **Five SECURITY DEFINER RLS helpers** were executable by `anon` and by the
   PUBLIC pseudo-role. Not exploitable (all key on `auth.uid()`, NULL for anon),
   but the repo's own rule says otherwise. Revoked from `anon`; `authenticated`
   retained because **policies evaluate as the querying role** and revoking it
   would lock users out of their own rows.

`findUnlockedDefinerFunctions` is now **per-role**: `anon` is never exempt; the
allowlist may only waive `authenticated`. That change immediately caught
`custom_access_token_hook` — absent from this project, but a fresh environment
applying `20260711000003` would create it anon-executable. Closed with a guarded
revoke.

**Verified after:** authenticated still reads 32 claims / 176 events; anon is
denied at the function layer and at the grant layer.

### Still open — needs a project owner

**Leaked-password protection is disabled** (Supabase Auth → HaveIBeenPwned
checking). For a product where an account controls settlement instructions and
bank details it should be on. Dashboard-only; cannot be set from SQL.

---

## 6. Production readiness: honest status

### Ready

- Engine correctness — two frozen rule sets, published conformance roots pinned
  by CI (`bc9f24fdab910a1b` / `261e3468d2246f30`), 500-case corpus each
- Tenancy — company-scoped, defence-in-depth (RLS **and** explicit
  `company_id` checks in every claim route)
- RBAC — enforced at the API layer, mutation-verified route audit, exercised
  in a browser as operator and viewer
- Test coverage — 2,802 app + 88 engine unit tests, 16 E2E across two specs,
  all green in CI on every push
- Grant/RLS posture — audited against the live catalog, two layers everywhere

### Not ready / needs a decision before real customers

| Item | Why it matters |
|---|---|
| **Demo credentials printed on `/sign-in`** | `demo2@laygrounded.com` / `demo1234` is rendered on the public sign-in page, and `operator@`/`viewer@` share that password. Fine for a sales demo, wrong the moment a real tenant exists alongside it. |
| **Leaked-password protection off** | See §5. |
| **Rate limiting is per-instance, in-memory** | `src/proxy.ts` resets on cold start and does not hold across a serverless fleet. It is a coarse anti-flood net, not a limiter. A shared store (Upstash/Vercel KV) is the real fix. |
| **No claim-deletion / GDPR erasure path** | Deliberate — a claim is evidence. But a real customer will eventually ask, and the answer needs to be designed rather than improvised. |
| **E2E suite mutates a shared tenant** | Serial, one worker, and it leaves identifiable artefacts by design. Against a production project this accumulates. Point it at a dedicated environment before go-live. |
| **`supabase_setup.sql` is stale** | Predates the newer migrations and is **not** the source of truth. A fresh environment must be built from `supabase/migrations/` in filename order. |
| **Backups / DR / monitoring** | Not assessed here. Supabase PITR, alerting and an incident runbook are prerequisites nobody has signed off. |

---

## 7. Where to start next

- `CLAUDE.md` (root) — engine versioning, auth/tenancy, RBAC, invitations
- `src/lib/CLAUDE.md` — module map, including `sharing/` and `export-csv.ts`
- `src/app/CLAUDE.md` — route conventions and layout gotchas
- `tests/e2e/README.md` — what the two specs cover and why they are serial

**Before starting a phase, confirm the base branch with `gh pr list`.** Phase 16
was requested "off main" on the belief that 14 and 15 were merged; they were open
and stacked, and branching off `main` silently reverted the tree to a pre-RBAC
codebase.
