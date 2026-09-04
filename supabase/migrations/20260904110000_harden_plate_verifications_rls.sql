-- Harden OCR verification audit table.
-- Client roles must never access this table directly; production access is server-side.
alter table public.plate_verifications enable row level security;

revoke all on table public.plate_verifications from anon, authenticated;
grant all on table public.plate_verifications to service_role;
