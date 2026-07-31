-- Which side of the fixture is this tenant on?
--
-- Until now the ETS addendum INFERRED it: the engine's money convention is
-- owner-perspective (net = demurrage earned − despatch paid), so the tenant was
-- assumed to be the shipping company and `counterparty_name` the charterer. The
-- addendum said so in a footnote, which is honest but leaves a real
-- misallocation one unread footnote away.
--
-- IT IS NOT A COSMETIC LABEL. It reverses the direction of the money:
--
--   tenant = owner      -> the surrender obligation is the TENANT's, and a
--                          BIMCO clause makes it RECOVERABLE from the
--                          counterparty. The amount is a receivable.
--   tenant = charterer  -> the obligation sits with the COUNTERPARTY (the
--                          shipping company), and a BIMCO clause makes the
--                          TENANT liable for it. The same amount is a PAYABLE.
--
-- Getting that backwards would tell a charterer they can invoice a cost they
-- actually owe. So the column is nullable and an unset role produces an
-- explicitly undetermined allocation — the same discipline as
-- `has_bimco_ets_clause` and `ets_applicable`.
--
-- PER-CLAIM, not per-company: a trader is routinely a charterer on one fixture
-- and a disponent owner on the next, and `chain_role` already establishes that
-- a claim carries its own position in the chain.
--
-- NOT backfilled to 'owner'. It is tempting — every existing calculation was
-- computed owner-perspective — but that is a property of the CALCULATION
-- convention, not evidence of the tenant's commercial role. Asserting it would
-- be the same inference this column exists to remove.

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS tenant_role text;

ALTER TABLE public.claims
  DROP CONSTRAINT IF EXISTS claims_tenant_role_check;

ALTER TABLE public.claims
  ADD CONSTRAINT claims_tenant_role_check
  CHECK (tenant_role IS NULL OR tenant_role IN ('owner', 'charterer', 'trader'));

COMMENT ON COLUMN public.claims.tenant_role IS
  'Which side of the fixture this company is on: owner (shipping company), charterer, or trader. Decides whether an EU-ETS allowance cost is a receivable or a payable for the tenant. NULL = not recorded; the addendum then declines to allocate rather than inferring. Deliberately not backfilled — the engine''s owner-perspective money convention is a calculation choice, not evidence of a commercial role.';
