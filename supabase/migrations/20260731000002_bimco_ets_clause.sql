-- Does this charterparty carry a BIMCO ETS clause?
--
-- WHY THIS DECIDES WHO PAYS. Under the EU ETS as extended to shipping
-- (Dir. 2003/87/EC as amended by 2023/959), the obligation to surrender
-- allowances rests on the SHIPPING COMPANY — the owner, or whoever has assumed
-- ISM responsibility for operating the vessel. It does not rest on the
-- charterer. Art. 3gc requires Member States to ensure the shipping company can
-- be reimbursed by the entity commercially responsible for the ship's
-- operation, but that recovery is CONTRACTUAL: absent a clause, the cost of a
-- demurrage period's emissions stays with the owner.
--
-- So a document asserting "charterer owes EUR X" is only correct when such a
-- clause exists. Without it the same figure is an UNRECOVERED OWNER COST, which
-- is a different commercial fact and a different conversation.
--
-- WHY A COLUMN AND NOT `cp_terms`. Two reasons:
--   1. `CpTermsSchema` is a zod object, which STRIPS unknown keys — a field
--      added to the jsonb would be silently discarded on every validated write.
--   2. `CpTerms` is the pure engine's input type, published in the Apache-2.0
--      laytime package. The engine never reads this flag and must not grow an
--      emissions-regulation concern. `claims.ets_applicable` already sets the
--      precedent for a compliance flag living on the claim.
--
-- TRI-STATE, deliberately:
--   NULL  = not recorded. Not the same as "no clause" — nobody has checked.
--   true  = clause present   -> recoverable from the charterer.
--   false = confirmed absent -> the owner carries it.
-- Defaulting NULL to false would silently assert that every legacy claim lacks
-- protection it may well have.

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS has_bimco_ets_clause boolean;

COMMENT ON COLUMN public.claims.has_bimco_ets_clause IS
  'Whether the CP carries a BIMCO ETS Emission Scheme clause (or equivalent) allowing the owner to recover EUA cost from the charterer. NULL = not recorded, which is NOT the same as absent. EU ETS places the surrender obligation on the shipping company; without such a clause the cost is an unrecovered owner cost, not a charterer liability.';
