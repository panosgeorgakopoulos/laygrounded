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
  'demo@laygrounded.com',
  crypt('password123', gen_salt('bf')),
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
