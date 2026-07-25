-- OAuth 2.1 + PKCE authorization server, for the LayGrounded MCP endpoint.
--
-- Lets an operator connect an AI client (Claude Desktop, an IDE, an agent) to
-- their own claims book without ever pasting a long-lived key into it. The
-- client gets a scoped, revocable, audience-bound token that acts as ONE user
-- inside ONE company — so every existing RLS predicate keeps working unchanged.
--
-- Five tables. The security of the whole flow sits in the constraints rather
-- than in application code wherever that is possible:
--
--   oauth_clients               who may ask (self-registered, RFC 7591)
--   oauth_authorization_codes   the one-time code + its PKCE challenge
--   oauth_access_tokens         what the client presents to the MCP endpoint
--   oauth_refresh_tokens        rotation, with reuse detection
--   oauth_consents              what the human actually agreed to
--
-- Nothing here is readable by `anon` or `authenticated`. Codes and tokens are
-- stored ONLY as SHA-256 hashes, exactly as api_keys already does (AD-035):
-- these are high-entropy random strings, not passwords, so there is no
-- dictionary to slow and a KDF on a path that runs per request would be a
-- self-inflicted DoS.

-- === 1. Clients (RFC 7591 dynamic registration) ===
-- An MCP client the operator installs today was not registered with us
-- yesterday, so it registers itself on first use. That means client_id is NOT
-- a secret and cannot be treated as authentication — PKCE is what proves the
-- caller redeeming a code is the one that started the flow.
CREATE TABLE IF NOT EXISTS public.oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  -- NULL for public clients. An installed desktop app cannot keep a secret,
  -- and OAuth 2.1 does not ask it to.
  client_secret_hash text,
  client_name text NOT NULL DEFAULT '',
  -- Exact-match allowlist. OAuth 2.1 forbids wildcard/prefix matching of
  -- redirect URIs: substring matching is the classic open-redirect that turns
  -- into account takeover, because the code is delivered to the attacker.
  redirect_uris text[] NOT NULL,
  grant_types text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  response_types text[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method text NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  scope text NOT NULL DEFAULT '',
  software_id text,
  software_version text,
  -- Registration is unauthenticated by design (that is what makes it
  -- dynamic), so it is rate-limited and clients are disableable.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_redirect_uris_present CHECK (cardinality(redirect_uris) > 0)
);

-- === 2. Authorization codes + PKCE challenge ===
-- The short-lived, single-use credential handed back through the user agent.
-- Every column here exists to bind it to something:
--   client_id      → only the client that asked may redeem it
--   redirect_uri   → must match the one used at /authorize, exactly
--   code_challenge → only the holder of the verifier may redeem it (PKCE)
--   resource       → the token minted from it is audience-bound (RFC 8707),
--                    so it cannot be replayed at a different MCP server
--   user_id/company_id → the identity the resulting token acts as
CREATE TABLE IF NOT EXISTS public.oauth_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The code itself is never stored. A database leak must not yield a set of
  -- live, redeemable codes.
  code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scope text NOT NULL DEFAULT '',

  -- PKCE (RFC 7636). Only the CHALLENGE is stored — it is the SHA-256 of the
  -- verifier, and storing the verifier would defeat the entire mechanism.
  code_challenge text NOT NULL,
  -- S256 only. 'plain' makes the challenge equal to the verifier, so anyone
  -- who intercepts the authorization request can redeem the code; OAuth 2.1
  -- and the MCP spec both require S256, and a CHECK is a cheaper guarantee
  -- than remembering to validate it in every code path.
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),

  -- RFC 8707 audience binding.
  resource text,

  -- Single use. Redemption sets consumed_at; presenting a consumed code is
  -- not merely refused — per RFC 6749 §4.1.2 it SHOULD revoke every token
  -- already issued from it, because a replay means the code leaked.
  consumed_at timestamptz,
  -- Deliberately short: the code lives only for the redirect hop.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON public.oauth_authorization_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON public.oauth_authorization_codes (user_id, created_at DESC);

-- === 3. Access tokens ===
CREATE TABLE IF NOT EXISTS public.oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Denormalised so the MCP request path resolves the tenant in ONE indexed
  -- lookup, and so a user later moved between companies cannot retroactively
  -- widen a token that was granted against the old one.
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT '',
  -- The audience this token was minted for. The MCP endpoint must reject a
  -- token whose audience is not itself.
  resource text,
  -- Which code produced it, so a replayed code can revoke its descendants.
  authorization_code_id uuid REFERENCES public.oauth_authorization_codes (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user ON public.oauth_access_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_expiry ON public.oauth_access_tokens (expires_at);

-- === 4. Refresh tokens, with rotation and reuse detection ===
-- OAuth 2.1 requires refresh tokens issued to public clients to be either
-- sender-constrained or single-use. Single-use is what is implementable here,
-- and rotation alone is not enough: rotation without reuse detection just
-- means a stolen token works once. Hence family_id.
--
-- Every refresh in a chain shares a family_id. Presenting an ALREADY-consumed
-- refresh token means two parties hold it — the legitimate client and a
-- thief — and there is no way to tell which one just called. The correct
-- response is to revoke the entire family, forcing a fresh user-present
-- authorization.
CREATE TABLE IF NOT EXISTS public.oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT '',
  resource text,
  access_token_id uuid REFERENCES public.oauth_access_tokens (id) ON DELETE SET NULL,
  -- Set when redeemed; a second presentation is the reuse signal.
  consumed_at timestamptz,
  -- The token this one was rotated into, so a chain is walkable.
  rotated_to_id uuid REFERENCES public.oauth_refresh_tokens (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON public.oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON public.oauth_refresh_tokens (user_id, created_at DESC);

-- === 5. Consents ===
-- What the human actually agreed to, kept apart from the tokens so that
-- revoking access is one row the USER can see and act on, rather than an
-- archaeology exercise across token tables. This is also the only OAuth table
-- a logged-in user can read: "which AI clients can reach my claims" is a
-- question they are entitled to answer for themselves.
CREATE TABLE IF NOT EXISTS public.oauth_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT '',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, client_id)
);

-- === 6. Housekeeping ===
-- Codes and expired tokens are disposable. Deleting them is not optional
-- hygiene: an unbounded table of dead credentials is both a liability and a
-- slow index.
CREATE OR REPLACE FUNCTION public.purge_expired_oauth_artifacts()
RETURNS TABLE (codes_deleted bigint, access_deleted bigint, refresh_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c bigint; a bigint; r bigint;
BEGIN
  DELETE FROM public.oauth_authorization_codes WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS c = ROW_COUNT;
  -- Keep expired access tokens briefly: they are what makes an audit of "what
  -- did this client do" possible after the token is dead.
  DELETE FROM public.oauth_access_tokens WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM public.oauth_refresh_tokens WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS r = ROW_COUNT;
  RETURN QUERY SELECT c, a, r;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_expired_oauth_artifacts() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_oauth_artifacts() TO service_role;

-- === 7. RLS ===
-- The OAuth machinery is service-role only. These tables hold the credentials
-- that guard the tenant's data; nothing that runs with an end-user JWT has any
-- business reading them, and RLS-on-with-no-policy denies by default (the same
-- mechanism that makes security_events append-only, AD-037).
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_consents ENABLE ROW LEVEL SECURITY;

-- The single deliberate exception: a user may see the grants they made, so
-- "which AI clients can reach my claims" is answerable in the app. Read only —
-- revocation goes through a route that also kills the tokens, which a plain
-- UPDATE here would not.
CREATE POLICY "Users read their own OAuth consents"
ON public.oauth_consents FOR SELECT
USING (user_id = auth.uid());

-- No policy on oauth_clients, oauth_authorization_codes, oauth_access_tokens
-- or oauth_refresh_tokens, and none should be added.
