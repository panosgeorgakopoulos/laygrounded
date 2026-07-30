-- Public marketing tools: abuse control and lead capture.
--
-- The weather checker is UNAUTHENTICATED and each query costs two upstream
-- calls (geocode + ERA5 archive). Without a durable counter, one script turns a
-- lead magnet into an outbound-bandwidth bill and gets our Open-Meteo access
-- throttled for the real product.
--
-- The proxy's in-memory limiter is per instance, so it cannot hold a "3 per
-- day" promise across a serverless fleet. This is the shared store that can.

-- === Usage counter ===
-- Keyed by a SALTED HASH of the IP, never the IP itself. We need to count
-- repeat callers; we do not need to know who they are, and storing raw
-- addresses for a marketing page would be collecting personal data we have no
-- use for.
create table if not exists public.public_tool_usage (
  ip_hash text not null,
  day date not null,
  tool text not null,
  request_count integer not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (ip_hash, day, tool)
);

create index if not exists idx_public_tool_usage_day on public.public_tool_usage (day);

-- === Leads ===
-- Written only when a visitor types an email to unlock the detailed report.
-- `context` records what they were looking at, which is the whole commercial
-- value of the lead — an email with no voyage attached is worth nothing.
create table if not exists public.public_tool_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  tool text not null,
  context jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists idx_public_tool_leads_created on public.public_tool_leads (created_at desc);
create index if not exists idx_public_tool_leads_email on public.public_tool_leads (lower(email));

-- === RLS ===
-- Enabled with NO policies: end users (anon and authenticated alike) can reach
-- neither table. The public routes touch them with the service-role client,
-- which bypasses RLS. That is deliberate — a marketing page must never be able
-- to read the lead list, and a logged-in customer has no business reading
-- another visitor's enquiry either.
alter table public.public_tool_usage enable row level security;
alter table public.public_tool_leads enable row level security;

-- === Atomic counter ===
-- Deliberately NOT SECURITY DEFINER: called only with the service-role client,
-- which already bypasses RLS, so definer rights would add privilege without
-- adding capability — and every SECURITY DEFINER function here must carry the
-- revoke-by-name discipline that definer-grants.test.ts enforces. Avoiding the
-- privilege avoids the whole class of mistake.
create or replace function public.increment_public_tool_usage(
  p_ip_hash text,
  p_day date,
  p_tool text
) returns integer
language sql
volatile
as $$
  insert into public.public_tool_usage (ip_hash, day, tool, request_count, last_seen)
  values (p_ip_hash, p_day, p_tool, 1, now())
  on conflict (ip_hash, day, tool) do update
    set request_count = public.public_tool_usage.request_count + 1,
        last_seen = now()
  returning request_count;
$$;

revoke all on function public.increment_public_tool_usage(text, date, text) from public, anon, authenticated;
