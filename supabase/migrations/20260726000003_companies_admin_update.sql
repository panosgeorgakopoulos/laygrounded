-- Let company admins actually update their own company row.
--
-- `companies` has carried a SELECT policy and nothing else since the initial
-- schema, so with RLS enabled every UPDATE through the cookie client matched
-- zero rows. `/api/settings` PATCH then dereferenced the null result and threw,
-- meaning the "Save Changes" button on Settings → Company has always returned an
-- opaque 500: renaming a company was never possible in the product.
--
-- It stayed hidden because the failure is an unexpected-error 500 rather than a
-- 403, and because nothing else writes to this table. It surfaced when the
-- market-data-sharing preference was added to the same row — a preference the
-- terms of service promise clients can change in their account settings, so it
-- has to work.
--
-- Admin-only, mirroring the explicit role check the route already performs:
-- RLS and the route check are meant to be defence in depth, and until now only
-- one of the two existed.

-- SECURITY DEFINER for the same reason as is_company_member: a policy on
-- `companies` that queried `company_members` directly would re-enter that
-- table's own policies. Reads only the caller's own membership.
CREATE OR REPLACE FUNCTION public.is_company_admin(target_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = target_company_id
      AND cm.user_id = auth.uid()
      AND cm.role = 'admin'
  );
$$;

-- Invoked from inside a policy expression, which evaluates as the querying
-- role, so `authenticated` must keep EXECUTE — the same reason the other RLS
-- helpers are allowlisted in src/lib/security/definer-grants.ts. `anon` has no
-- auth.uid() and so can never get true from it, but it is revoked regardless.
REVOKE EXECUTE ON FUNCTION public.is_company_admin(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated, service_role;

CREATE POLICY "Company admins can update their company"
  ON public.companies FOR UPDATE
  USING (public.is_company_admin(id))
  WITH CHECK (public.is_company_admin(id));
