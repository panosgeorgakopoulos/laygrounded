-- Down migration for 20260718000000_oauth_mcp.sql — reverse order.
--
-- NB this disconnects every AI client an operator has linked. Tokens are
-- stored only as hashes and cannot be regenerated, so re-applying the up
-- migration does not restore access: every user must re-authorize their
-- client through the consent screen.

DROP POLICY IF EXISTS "Users read their own OAuth consents" ON public.oauth_consents;

DROP FUNCTION IF EXISTS public.purge_expired_oauth_artifacts();

-- Refresh before access (rotated_to_id / access_token_id references), then the
-- codes, then the clients everything else points at.
DROP TABLE IF EXISTS public.oauth_consents;
DROP TABLE IF EXISTS public.oauth_refresh_tokens;
DROP TABLE IF EXISTS public.oauth_access_tokens;
DROP TABLE IF EXISTS public.oauth_authorization_codes;
DROP TABLE IF EXISTS public.oauth_clients;
