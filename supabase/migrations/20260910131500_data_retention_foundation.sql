-- ParkingMartin-G: non-destructive foundation for operational data retention.
-- This migration does NOT schedule or execute any purge.

create table if not exists public.data_retention_config (
  singleton_id smallint primary key default 1,
  evidence_retention_days integer not null default 15,
  history_retention_days integer not null default 365,
  updated_by_telegram_user_id bigint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_retention_config_singleton check (singleton_id = 1),
  constraint data_retention_evidence_days_positive check (evidence_retention_days >= 1),
  constraint data_retention_history_days_after_evidence check (history_retention_days > evidence_retention_days),
  constraint data_retention_history_days_reasonable check (history_retention_days <= 3650),
  constraint data_retention_updated_by_fkey foreign key (updated_by_telegram_user_id)
    references public.telegram_users(telegram_user_id) on delete set null
);

insert into public.data_retention_config(singleton_id, evidence_retention_days, history_retention_days)
values (1, 15, 365)
on conflict (singleton_id) do nothing;

alter table public.data_retention_config enable row level security;
revoke all on table public.data_retention_config from public, anon, authenticated;
grant select, insert, update, delete on table public.data_retention_config to service_role;

create table if not exists public.vehicle_disputes (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  status text not null default 'open',
  reason text not null,
  opened_by_telegram_user_id bigint null references public.telegram_users(telegram_user_id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_by_telegram_user_id bigint null references public.telegram_users(telegram_user_id) on delete set null,
  closed_at timestamptz null,
  close_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicle_disputes_status_check check (status in ('open','closed')),
  constraint vehicle_disputes_reason_not_blank check (length(btrim(reason)) > 0),
  constraint vehicle_disputes_close_state_check check (
    (status = 'open' and closed_at is null)
    or (status = 'closed' and closed_at is not null)
  )
);

create unique index if not exists vehicle_disputes_one_open_per_vehicle
  on public.vehicle_disputes(vehicle_id)
  where status = 'open';
create index if not exists vehicle_disputes_vehicle_history_idx
  on public.vehicle_disputes(vehicle_id, opened_at desc);

alter table public.vehicle_disputes enable row level security;
revoke all on table public.vehicle_disputes from public, anon, authenticated;
grant select, insert, update, delete on table public.vehicle_disputes to service_role;

create or replace function public.vehicle_has_open_dispute(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.vehicle_disputes d
    where d.vehicle_id = p_vehicle_id
      and d.status = 'open'
  );
$$;

revoke all on function public.vehicle_has_open_dispute(uuid) from public, anon, authenticated;
grant execute on function public.vehicle_has_open_dispute(uuid) to service_role;
