-- DOWN for 20260715000000_hitl_reviews.sql
-- DESTRUCTIVE: drops the human-approval audit trail (who approved which
-- settlement/protest). Export before running in any regulated context.
DROP TABLE IF EXISTS public.pending_human_reviews;
