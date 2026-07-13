-- DOWN for 20260714000003_settlement_clearinghouse.sql
-- DESTRUCTIVE: drops the settlement ledger, including cleared-transfer
-- records. claims.settled_amount/settled_at written by cleared settlements
-- are claim-level facts and are deliberately NOT reverted.
DROP TABLE IF EXISTS public.settlements;
