# API routes and app layout

## API route conventions

- **Capability gating.** A route that moves money, issues a credential or mutates a claim calls `requireCapability(cap)` (no claim yet) or `assertCapability(auth, cap)` after its ownership check — see the Roles section in the root `CLAUDE.md`. Add it to `GATED_ROUTES` in `src/lib/auth/route-guards.test.ts` in the same change; that test is what stops the gate from silently disappearing in a later refactor. The route must return errors through `apiError()`, or the `FORBIDDEN` throw becomes an opaque 500 — four routes had exactly that hand-rolled catch and were converted in Phase 14.
- Routes live under `src/app/api/`. Business errors are thrown as sentinel string messages (`"CLAIM_NOT_FOUND"`, `"INVALID_CP_TERMS"`, …) and converted by `apiError()` in `src/lib/api-errors.ts`, which maps known sentinels to their HTTP status and turns anything unknown into a logged, opaque 500. Add new sentinels to `DEFAULT_KNOWN` or pass them via `extraKnown`.
- `src/proxy.ts` (Next.js 16 renamed `middleware.ts` → `proxy.ts` — there is no `src/middleware.ts`) applies per-instance in-memory rate limiting to `/api` and `/oauth/*` (`oauth-reg:` 15/min on the unauthenticated RFC-7591 registration write, `oauth:` 60/min elsewhere), a deny-by-default CORS allowlist (`ALLOWED_ORIGINS`), and redirects users with a Supabase auth cookie from `/`, `/sign-in`, `/sign-up` to `/claims`.

## Layout gotchas

- `src/app/(authenticated)/` is guarded client-side by the layout plus proxy redirects. The layout also redirects a user who is **authenticated but has no company** to `/onboarding` — that state is a 401 from `/api/me` carrying `NO_COMPANY`, which `role-provider.tsx` separates from `UNAUTHORIZED` by reading the error body, because the two need opposite destinations and share a status code.
- `src/app/rooms/[token]/` — the public claim room (server-rendered, token-authenticated, `robots noindex`); intentionally **outside** the authenticated group and the proxy matcher. Don't "fix" this by moving it in.
- `src/app/invite/accept/` and `src/app/onboarding/` are outside the authenticated group for the same reason: the person arriving has no tenant, and often no session. The authenticated layout would bounce them to `/sign-in` with no memory of the invitation token, and its chrome (nav, notification bell) queries a company that does not exist. Both are `robots noindex`; the invite page is also `referrer: no-referrer`, because the token is a credential in the URL.
- **`/invite/accept` never mutates on GET.** Acceptance is a POST behind a button — a link-preview bot in a mail client fetches every URL it sees, and would otherwise redeem the invitation before the human clicked it.
- The proxy's signed-in redirect honours `?next=` (same-site paths only). Without it, a signed-in user clicking an invite link is bounced from `/sign-in` to `/claims`, the destination is discarded, and the invitation is never accepted.
