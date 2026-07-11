-- 1. Create the custom access token auth hook
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    claims jsonb;
    user_company_id uuid;
BEGIN
    -- Fetch the user's company_id
    SELECT company_id INTO user_company_id 
    FROM public.company_members 
    WHERE user_id = (event->>'user_id')::uuid
    LIMIT 1;

    claims := event->'claims';

    IF user_company_id IS NOT NULL THEN
        -- Inject company_id into app_metadata
        claims := jsonb_set(claims, '{app_metadata, company_id}', to_jsonb(user_company_id));
    ELSE
        -- Remove company_id if it doesn't exist
        claims := claims #- '{app_metadata, company_id}';
    END IF;

    -- Update the 'claims' object in the original event
    event := jsonb_set(event, '{claims}', claims);

    -- Return the modified event
    RETURN event;
END;
$$;

-- Grant permissions for Supabase Auth to execute the hook
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;

-- 2. Rewrite RLS Policies for high performance via JWT app_metadata evaluation

-- Drop old, subquery-heavy policies
DROP POLICY IF EXISTS "Users can perform all actions on claims of their company" ON public.claims;
DROP POLICY IF EXISTS "Users can perform all actions on documents of their company claims" ON public.documents;
DROP POLICY IF EXISTS "Users can perform all actions on sof_events of their company claims" ON public.sof_events;
DROP POLICY IF EXISTS "Users can perform all actions on clause_flags of their company claims" ON public.clause_flags;
DROP POLICY IF EXISTS "Users can perform all actions on laytime_calculations of their company claims" ON public.laytime_calculations;

-- Create high-performance JWT evaluated policies
CREATE POLICY "Users can perform all actions on claims of their company"
ON public.claims FOR ALL
USING ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid )
WITH CHECK ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid );

CREATE POLICY "Users can perform all actions on laytime_calculations of their company claims"
ON public.laytime_calculations FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = laytime_calculations.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = laytime_calculations.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users can perform all actions on documents of their company claims"
ON public.documents FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = documents.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = documents.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users can perform all actions on sof_events of their company claims"
ON public.sof_events FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = sof_events.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = sof_events.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users can perform all actions on clause_flags of their company claims"
ON public.clause_flags FOR ALL
USING (
  (SELECT c.company_id FROM public.claims c JOIN public.sof_events e ON e.claim_id = c.id WHERE e.id = clause_flags.event_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT c.company_id FROM public.claims c JOIN public.sof_events e ON e.claim_id = c.id WHERE e.id = clause_flags.event_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

-- 3. Create missing compound index
CREATE INDEX IF NOT EXISTS idx_lay_calc_claim_computed ON public.laytime_calculations(claim_id, computed_at DESC);
