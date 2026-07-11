-- Insert demo user (demo@laygrounded.com / password123)
insert into auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  role,
  raw_user_meta_data
) values (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'demo2@laygrounded.com',
  crypt('demo1234', gen_salt('bf')),
  now(),
  now(),
  now(),
  'authenticated',
  '{"name": "Demo Captain"}'
) on conflict (id) do nothing;

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  created_at,
  updated_at
) values (
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111", "email":"demo@laygrounded.com"}',
  'email',
  now(),
  now()
) on conflict do nothing;

-- Create demo company
insert into public.companies (id, name)
values ('22222222-2222-2222-2222-222222222222', 'Demo Shipping Co.')
on conflict do nothing;

-- Link demo user to demo company
insert into public.company_members (user_id, company_id, role)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'admin')
on conflict do nothing;

-- Demo Data Injection
insert into public.claims (id, company_id, vessel, voyage_ref, port, cargo, cp_form, status, cp_terms, created_by)
values
('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'MV Pacific Star', 'VOY-24-001', 'Rotterdam', 'Steel Coils', 'GENCON 94', 'demurrage', '{"currency": "USD", "days_basis": "SHINC", "load_rate": 0, "nor_variant": "WIBON", "port_timezone": "UTC", "despatch_rate": 7500, "demurrage_rate": 15000, "discharge_rate": 0, "turn_time_hours": 6, "laytime_allowed_hours": 72}', '11111111-1111-1111-1111-111111111111'),
('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'MV Atlantic Pearl', 'VOY-24-002', 'Singapore', 'Iron Ore', 'GENCON 94', 'processing', null, '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

insert into public.documents (id, claim_id, storage_path, mime, original_filename, extraction_status, page_count)
values
('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222/sof_pacific_star.pdf', 'application/pdf', 'sof_pacific_star.pdf', 'completed', 2),
('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222/sof_atlantic_pearl.pdf', 'application/pdf', 'sof_atlantic_pearl.pdf', 'extracting', 1)
on conflict do nothing;

insert into public.sof_events (id, claim_id, document_id, occurred_at, event_type, raw_text, status, ai_reasoning, page)
values
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T10:00:00Z', 'NOR_TENDERED', 'Notice of Readiness tendered at 1000 hrs', 'accepted', 'Explicit NOR tendered', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T14:00:00Z', 'ALL_FAST', 'Vessel all fast at berth 1400 hrs', 'accepted', 'All fast time', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T16:00:00Z', 'COMMENCED_DISCHARGE', 'Commenced discharge at 1600', 'accepted', 'Discharge start', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-02T10:00:00Z', 'WEATHER_DELAY', 'Rain delay from 1000', 'accepted', 'Rain delay start', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-02T14:00:00Z', 'WEATHER_DELAY', 'Rain stopped at 1400', 'accepted', 'Rain delay end', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-06T12:00:00Z', 'COMPLETED_DISCHARGE', 'Completed discharge 1200 hrs', 'accepted', 'Discharge finish', 1);

insert into public.laytime_calculations (claim_id, breakdown, allowed_hours, used_hours, demurrage_amount, despatch_amount, currency)
values
('33333333-3333-3333-3333-333333333333', '[{"hour":"2024-03-01T16:00:00Z","status":"laytime","counts":true,"clause_ref":"GENCON94-6c","reasoning":"Laytime counting."}]'::jsonb, 72, 116, 27500.00, 0, 'USD')
on conflict do nothing;
