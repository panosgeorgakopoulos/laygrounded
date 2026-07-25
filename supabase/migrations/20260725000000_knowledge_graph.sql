-- Legal Knowledge Graph (A5) — the public, SEO-facing clause & precedent library.
--
-- This is the ONE deliberately public-read surface in the schema: anon SELECT is
-- granted so the pages are crawlable and shareable. It holds NO tenant data —
-- only standard charter-party clause reference (LayGrounded's own descriptions of
-- the GENCON 94 / ASBATANKVOY forms the engine implements) and, later, licensed
-- case-law precedents imported via scripts/seed/kb-import.ts. Writes are
-- service-role only (which bypasses RLS); nothing here is fabricated law.

-- === Clauses ===
create table if not exists public.kb_clauses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  cp_form text not null default 'GENERAL',   -- GENCON94 | ASBATANKVOY | GENERAL
  clause_ref text,                            -- engine ref (GENCON94-8, ASBA-II-8); null for concepts
  title text not null,
  body text not null,
  tags text[] not null default '{}',
  source_label text not null default 'Standard charter-party form',
  source_url text,
  is_curated boolean not null default true,   -- repo-owned/curated vs imported
  -- Full-text index. to_tsvector(regconfig, …) is IMMUTABLE, so it is usable in
  -- a generated column; title and clause_ref weigh heaviest.
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(clause_ref, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B') ||
    setweight(array_to_tsvector(tags), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_kb_clauses_search on public.kb_clauses using gin (search);
create index if not exists idx_kb_clauses_cp_form on public.kb_clauses (cp_form);

-- === Precedents (ships EMPTY) ===
-- Populated ONLY from a user-supplied licensed source; source_label is NOT NULL
-- so every row is attributable. Never auto-generated.
create table if not exists public.kb_precedents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  case_name text not null,
  citation text,
  jurisdiction text,
  decided_on date,
  summary text not null,
  holding text,
  tags text[] not null default '{}',
  source_label text not null,
  source_url text,
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(case_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(citation, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(holding, '')), 'B') ||
    setweight(array_to_tsvector(tags), 'C')
  ) stored,
  created_at timestamptz not null default now()
);
create index if not exists idx_kb_precedents_search on public.kb_precedents using gin (search);

-- === RLS: public read, no client writes ===
alter table public.kb_clauses enable row level security;
alter table public.kb_precedents enable row level security;

create policy "Knowledge clauses are public" on public.kb_clauses
  for select to anon, authenticated using (true);
create policy "Knowledge precedents are public" on public.kb_precedents
  for select to anon, authenticated using (true);

grant select on public.kb_clauses to anon, authenticated;
grant select on public.kb_precedents to anon, authenticated;

-- === Curated clause reference seed ===
-- LayGrounded's plain-language descriptions of the standard forms the engine
-- computes against. Idempotent (upsert on slug), so re-applying refreshes text.
insert into public.kb_clauses (slug, cp_form, clause_ref, title, body, tags, source_label) values
  ('gencon94-6-commencement', 'GENCON94', 'GENCON94-6',
   'GENCON 94 Clause 6 — Commencement of Laytime',
   'Under GENCON 94, laytime begins once a valid Notice of Readiness (NOR) has been tendered and accepted, after any agreed turn time has elapsed. The vessel must be physically and legally ready to load or discharge for the NOR to be effective.',
   array['laytime','nor','commencement','turn-time'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-6c-nor-anchorage', 'GENCON94', 'GENCON94-6c',
   'GENCON 94 Clause 6(c) — NOR at Anchorage (WIBON / WIPON)',
   'Where a berth is unavailable, "Whether In Berth Or Not" (WIBON) lets a valid NOR be tendered from the usual waiting place; time then counts subject to the charter. Time spent shifting from the waiting place to berth may or may not count depending on the agreed NOR variant.',
   array['nor','wibon','wipon','anchorage','shifting'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-7-laytime-calculation', 'GENCON94', 'GENCON94-7',
   'GENCON 94 Clause 7 — Laytime Calculation',
   'Laytime used is measured from commencement to the completion of loading or discharging, subject to the agreed exceptions. The days basis (SHINC, SHEX, or SHEX unless used) governs whether Sundays and holidays are counted.',
   array['laytime','calculation','days-basis'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-7b-shinc', 'GENCON94', 'GENCON94-7(b)',
   'SHINC — Sundays and Holidays Included',
   'On a SHINC basis, Sundays and holidays count as laytime like any other time. Laytime runs continuously once commenced.',
   array['shinc','days-basis','laytime'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-7c-shex', 'GENCON94', 'GENCON94-7(c)',
   'SHEX — Sundays and Holidays Excepted',
   'On a SHEX basis, Sundays and holidays are excepted from laytime whether or not work is done. Port-local time zones determine which calendar days are excluded.',
   array['shex','days-basis','laytime','exceptions'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-7d-shex-uu', 'GENCON94', 'GENCON94-7(d)',
   'SHEX Unless Used (SHEX-UU)',
   'Under SHEX unless used, Sundays and holidays are excepted only if no work is performed; time actually worked on those days counts as laytime. Evidence that hatches were open and operations ongoing is what makes the time count.',
   array['shex-uu','days-basis','laytime','exceptions'], 'Standard charter-party form (GENCON 94)'),

  ('gencon94-8-demurrage', 'GENCON94', 'GENCON94-8',
   'GENCON 94 Clause 8 — Demurrage and Despatch',
   'Once the allowed laytime is exhausted the vessel is on demurrage, which runs continuously at the agreed daily rate, pro rata for part of a day. "Once on demurrage, always on demurrage": weather, weekends and shifting do not interrupt it. Despatch rewards time saved, usually at half the demurrage rate.',
   array['demurrage','despatch','once-on-demurrage'], 'Standard charter-party form (GENCON 94)'),

  ('asbatankvoy-6-nor', 'ASBATANKVOY', 'ASBA-II-6',
   'ASBATANKVOY Part II Clause 6 — NOR and Commencement of Laytime',
   'Under ASBATANKVOY, laytime commences six hours after a valid NOR is tendered, or on the vessel berthing, whichever is earlier. Berthing before the six hours elapse therefore cuts the turn time short.',
   array['asbatankvoy','nor','laytime','turn-time'], 'Standard charter-party form (ASBATANKVOY)'),

  ('asbatankvoy-7-running-hours', 'ASBATANKVOY', 'ASBA-II-7',
   'ASBATANKVOY Part II Clause 7 — Hours for Loading and Discharging (Running Hours)',
   'Tanker laytime under ASBATANKVOY runs on "running hours" — laytime is continuous once commenced and, unlike weather-working-day regimes, weather does not stop the clock. This is a materially owner-friendly counting basis.',
   array['asbatankvoy','running-hours','laytime','weather'], 'Standard charter-party form (ASBATANKVOY)'),

  ('asbatankvoy-8-demurrage', 'ASBATANKVOY', 'ASBA-II-8',
   'ASBATANKVOY Part II Clause 8 — Demurrage (Half Rate for Weather / Breakdown)',
   'Demurrage runs at the agreed rate, but is billed at HALF rate for time lost to storm, fire or explosion, or a breakdown of machinery beyond the charterer''s control. The engine tracks these half-rate hours separately.',
   array['asbatankvoy','demurrage','half-rate','weather','breakdown'], 'Standard charter-party form (ASBATANKVOY)'),

  ('concept-notice-of-readiness', 'GENERAL', null,
   'Notice of Readiness (NOR)',
   'A Notice of Readiness is the master''s formal notice that the vessel has arrived and is ready in all respects to load or discharge. A valid, accepted NOR is the trigger that starts laytime; an invalid or premature NOR can delay commencement by days.',
   array['nor','laytime','concept'], 'LayGrounded reference'),

  ('concept-turn-time', 'GENERAL', null,
   'Turn Time',
   'Turn time is an agreed grace period between an accepted NOR and the start of laytime, reflecting the customary time to make ready. It is deducted before laytime begins to count.',
   array['turn-time','laytime','concept'], 'LayGrounded reference'),

  ('concept-wibon', 'GENERAL', null,
   'WIBON — Whether In Berth Or Not',
   'WIBON allows a valid NOR to be given from the usual waiting place when no berth is available, so waiting time can count against laytime. Related variants include WIPON (whether in port or not), WICCON and WIFPON.',
   array['wibon','wipon','nor','concept'], 'LayGrounded reference'),

  ('concept-weather-working-day', 'GENERAL', null,
   'Weather Working Day (WWD)',
   'A weather working day is a day (or part-day) on which work would normally proceed were it not prevented by weather. Under weather-working bases, time lost to weather is excepted from laytime — in contrast to running-hours regimes where weather does not stop the clock.',
   array['wwd','weather','days-basis','concept'], 'LayGrounded reference'),

  ('concept-demurrage-despatch', 'GENERAL', null,
   'Demurrage and Despatch',
   'Demurrage is liquidated damages the charterer pays the owner for exceeding the allowed laytime; despatch is a reward, usually half the demurrage rate, for completing sooner. Both are computed from the laytime statement.',
   array['demurrage','despatch','concept'], 'LayGrounded reference'),

  ('concept-laytime', 'GENERAL', null,
   'Laytime',
   'Laytime is the period the charterer is allowed, free of freight, to load or discharge the cargo. How it is counted — the days basis, exceptions, and NOR regime — determines whether a voyage ends in demurrage or despatch.',
   array['laytime','concept'], 'LayGrounded reference')
on conflict (slug) do update set
  cp_form = excluded.cp_form,
  clause_ref = excluded.clause_ref,
  title = excluded.title,
  body = excluded.body,
  tags = excluded.tags,
  source_label = excluded.source_label,
  updated_at = now();
