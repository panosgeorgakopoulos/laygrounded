-- Resolve a LayGrounded user by phone number, for inbound-SMS SoF ingestion.
--
-- Mirrors get_user_id_by_email (00000000000000_init.sql): SECURITY DEFINER so it
-- can read auth.users, returning ONLY the user id, never any auth material. Both
-- sides are reduced to digits, so a Twilio E.164 "+1 415…" matches whatever
-- formatting Supabase happens to have stored the phone in. The empty-phone guard
-- stops a caller with no number matching the many accounts that have none.
create or replace function get_user_id_by_phone(phone_number text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users
  where regexp_replace(coalesce(phone, ''), '\D', '', 'g')
      = regexp_replace(coalesce(phone_number, ''), '\D', '', 'g')
    and coalesce(phone, '') <> ''
  limit 1;
$$;

-- Only the service role calls this (the SMS route runs service-role); no
-- end-user JWT has any business resolving accounts by phone.
revoke execute on function get_user_id_by_phone(text) from public, anon, authenticated;
grant execute on function get_user_id_by_phone(text) to service_role;
