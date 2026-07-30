-- Cargo weather profiles: what weather actually stops THIS cargo.
--
-- Today `WEATHER_THRESHOLDS` in evidence/weather.ts is one cargo-agnostic set,
-- so grain and steel are treated identically. That is wrong in both directions:
-- rain stops grain and does not stop steel, while steel cares about crane wind
-- limits that grain barely notices. Getting this wrong is the single largest
-- source of demurrage argument.
--
-- A NULL threshold means INSENSITIVE to that dimension, which is different from
-- zero (zero would stop the vessel on the first drop of rain). The distinction
-- is load-bearing and the resolver depends on it.

create table if not exists public.cargo_weather_profiles (
  id uuid primary key default gen_random_uuid(),
  -- NULL = curated global default, visible to every tenant. A row with a
  -- company_id overrides the global for that tenant only.
  company_id uuid references public.companies (id) on delete cascade,
  -- Normalised (lowercased, trimmed) so "Iron Ore" and "iron ore" are one cargo.
  cargo_key text not null,
  label text not null,

  -- Thresholds. NULL = this cargo is insensitive to this dimension.
  precip_mm_per_hr double precision check (precip_mm_per_hr is null or precip_mm_per_hr >= 0),
  wind_kn double precision check (wind_kn is null or wind_kn >= 0),
  gust_kn double precision check (gust_kn is null or gust_kn >= 0),
  min_temp_c double precision,
  max_temp_c double precision,

  -- A ten-minute shower is not a stoppage. "Weather working day" means time
  -- actually lost, so runs shorter than this are not excepted.
  min_stoppage_minutes integer not null default 60
    check (min_stoppage_minutes > 0 and min_stoppage_minutes <= 1440),

  -- MANDATORY. A threshold is a commercial assertion that decides real money;
  -- a row that cannot say where it came from does not belong in a calculation.
  -- Same discipline as kb_precedents.
  source_label text not null,
  notes text,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One profile per cargo per scope. Partial indexes because NULL company_id is
-- the global scope and Postgres treats NULLs as distinct in a plain unique index.
create unique index if not exists uniq_cargo_profile_global
  on public.cargo_weather_profiles (cargo_key) where company_id is null;
create unique index if not exists uniq_cargo_profile_company
  on public.cargo_weather_profiles (company_id, cargo_key) where company_id is not null;

-- === RLS ===
alter table public.cargo_weather_profiles enable row level security;

-- Curated globals are reference data: readable by any authenticated user,
-- writable by nobody through this policy (service role only, as with kb_*).
create policy "Global cargo profiles are readable"
  on public.cargo_weather_profiles for select
  to authenticated
  using (company_id is null);

create policy "Users manage their company's cargo profiles"
  on public.cargo_weather_profiles for all
  to authenticated
  using (company_id is not null and public.is_company_member(company_id))
  with check (company_id is not null and public.is_company_member(company_id));

-- === Curated baselines ===
--
-- Starting points, not findings. Every row is labelled overridable and a tenant
-- can shadow any of them with its own row. They are deliberately conservative
-- where a cargo is genuinely sensitive (hygroscopic bulks) and deliberately
-- silent — NULL, not a large number — where a cargo does not care.
insert into public.cargo_weather_profiles
  (company_id, cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn, min_stoppage_minutes, source_label, notes)
values
  (null, 'grain', 'Grain and agribulk', 0.2, null, 35,
   60, 'LayGrounded Baseline Default - Overridable',
   'Hygroscopic: hatches close on light rain. Wind matters mainly through gust limits on grain spouts.'),
  (null, 'steel', 'Steel and steel products', null, 40, 50,
   60, 'LayGrounded Baseline Default - Overridable',
   'Insensitive to rain — NULL, not a high number. Governed by crane and slinging wind limits.'),
  (null, 'cement', 'Cement and clinker', 0.1, 30, 40,
   60, 'LayGrounded Baseline Default - Overridable',
   'Highly hygroscopic; sets on contact with water. The tightest precipitation threshold of the defaults.'),
  (null, 'coal', 'Coal and petcoke', 2.0, 35, 45,
   60, 'LayGrounded Baseline Default - Overridable',
   'Weather-tolerant: only heavy rain interrupts. Dust suppression may make light rain welcome.'),
  (null, 'fertilizer', 'Fertilizers', 0.1, 30, 40,
   60, 'LayGrounded Baseline Default - Overridable',
   'Highly hygroscopic and prone to caking; treated as tightly as cement.'),
  (null, 'iron ore', 'Iron ore and bulk minerals', 2.0, 35, 45,
   60, 'LayGrounded Baseline Default - Overridable',
   'Weather-tolerant bulk; governed by grab-crane wind limits rather than precipitation.')
on conflict do nothing;

-- Cargo strings are free text written by operators ("Soybeans, 54,000 MT",
-- "Iron Ore Fines"). Matching only on cargo_key misses nearly every real claim,
-- which would make these seeded defaults useless in practice.
alter table public.cargo_weather_profiles
  add column if not exists aliases text[] not null default '{}';

update public.cargo_weather_profiles set aliases = array[
  'soybean','soya','soy','wheat','corn','maize','barley','sorghum','rice','oats','rapeseed','canola','agribulk','grains'
] where company_id is null and cargo_key = 'grain';

update public.cargo_weather_profiles set aliases = array[
  'hms','scrap','rebar','billet','slab','coil','plate','pig iron','steel products'
] where company_id is null and cargo_key = 'steel';

update public.cargo_weather_profiles set aliases = array['clinker','cement clinker']
  where company_id is null and cargo_key = 'cement';

update public.cargo_weather_profiles set aliases = array[
  'petcoke','pet coke','thermal coal','coking coal','anthracite'
] where company_id is null and cargo_key = 'coal';

update public.cargo_weather_profiles set aliases = array[
  'urea','dap','map','potash','ammonium','phosphate','npk','sulphur','sulfur'
] where company_id is null and cargo_key = 'fertilizer';

update public.cargo_weather_profiles set aliases = array[
  'iron','ore','bauxite','manganese','nickel ore','mineral'
] where company_id is null and cargo_key = 'iron ore';
