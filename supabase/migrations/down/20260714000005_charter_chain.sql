-- DOWN for 20260714000005_charter_chain.sql
-- DESTRUCTIVE: severs chain linkage and drops fact locks. Sub-claims survive
-- as ordinary standalone claims (their cloned events keep source='chain').
ALTER TABLE public.sof_events
  DROP COLUMN IF EXISTS locked_reason,
  DROP COLUMN IF EXISTS locked;
DROP INDEX IF EXISTS public.idx_claims_parent;
ALTER TABLE public.claims
  DROP COLUMN IF EXISTS chain_depth,
  DROP COLUMN IF EXISTS chain_role,
  DROP COLUMN IF EXISTS parent_claim_id;
