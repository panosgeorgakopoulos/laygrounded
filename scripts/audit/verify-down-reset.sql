-- Asserts that the down migrations fully reset schema state: no table,
-- matview, function, or column introduced by 20260714000001–20260715000001
-- may survive. Run inside a transaction after applying all ups then all
-- downs (see scripts/audit/README or the migration-sandwich command).
DO $$
DECLARE
  leftover text;
BEGIN
  FOREACH leftover IN ARRAY ARRAY['voyage_alerts', 'settlements', 'insurance_policies',
                                  'insurance_triggers', 'pending_human_reviews',
                                  'data_lineage', 'honesty_index', 'oracle_voyage_stats']
  LOOP
    IF to_regclass('public.' || leftover) IS NOT NULL THEN
      RAISE EXCEPTION 'DOWN INCOMPLETE: relation % still exists', leftover;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'claims'
               AND column_name IN ('parent_claim_id', 'chain_role', 'chain_depth')) THEN
    RAISE EXCEPTION 'DOWN INCOMPLETE: chain columns remain on claims';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'sof_events'
               AND column_name IN ('locked', 'locked_reason')) THEN
    RAISE EXCEPTION 'DOWN INCOMPLETE: lock columns remain on sof_events';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('refresh_honesty_index', 'refresh_oracle_voyage_stats')) THEN
    RAISE EXCEPTION 'DOWN INCOMPLETE: refresh functions remain';
  END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'drafts_kind_check')
     LIKE '%letter_of_protest%' THEN
    RAISE EXCEPTION 'DOWN INCOMPLETE: drafts_kind_check still allows letter_of_protest';
  END IF;

  RAISE NOTICE 'DOWN MIGRATIONS FULLY RESET STATE';
END $$;
