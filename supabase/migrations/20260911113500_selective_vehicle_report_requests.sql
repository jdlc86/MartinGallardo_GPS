-- Temporary server-side selection state for selective Expediente 360 PDF exports.
-- Keeps long evidence selections out of the signed URL and expires automatically.

create table if not exists public.vehicle_report_requests (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  stay_id uuid not null references public.vehicle_stays(id) on delete cascade,
  created_by_telegram_user_id bigint not null,
  selection jsonb not null default '{}'::jsonb,
  estimated_source_bytes bigint not null default 0 check (estimated_source_bytes >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_accessed_at timestamptz
);

create index if not exists vehicle_report_requests_expires_at_idx
  on public.vehicle_report_requests(expires_at);

alter table public.vehicle_report_requests enable row level security;

revoke all on table public.vehicle_report_requests from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname='vehicle-report-requests-cleanup') then
    perform cron.unschedule('vehicle-report-requests-cleanup');
  end if;
end $$;

select cron.schedule(
  'vehicle-report-requests-cleanup',
  '17 * * * *',
  $$delete from public.vehicle_report_requests where expires_at < now() - interval '1 hour';$$
);
