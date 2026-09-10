-- ParkingMartin-G: vehicle/stay identity foundation.
-- Backward-compatible: existing vehicle rows remain the current operational identity.
-- No existing UNIQUE constraint is removed and no operational flow is changed here.

create table if not exists public.vehicle_stays (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  normalized_plate text not null,
  stay_code text not null,
  sequence_on_day integer not null,
  started_at timestamptz not null,
  delivered_at timestamptz null,
  status text not null default 'active',
  evidence_purged_at timestamptz null,
  history_purge_eligible_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicle_stays_sequence_positive check (sequence_on_day >= 1),
  constraint vehicle_stays_status_check check (status in ('active','delivered','historical','purged')),
  constraint vehicle_stays_stay_code_not_blank check (length(btrim(stay_code)) > 0)
);

create unique index if not exists vehicle_stays_code_key
  on public.vehicle_stays(stay_code);
create unique index if not exists vehicle_stays_plate_day_sequence_key
  on public.vehicle_stays(normalized_plate, ((started_at at time zone 'Europe/Madrid')::date), sequence_on_day);
create index if not exists vehicle_stays_vehicle_started_idx
  on public.vehicle_stays(vehicle_id, started_at desc);
create index if not exists vehicle_stays_plate_started_idx
  on public.vehicle_stays(normalized_plate, started_at desc);
create index if not exists vehicle_stays_retention_idx
  on public.vehicle_stays(status, delivered_at)
  where delivered_at is not null;

alter table public.vehicle_stays enable row level security;
revoke all on table public.vehicle_stays from public, anon, authenticated;
grant select, insert, update, delete on table public.vehicle_stays to service_role;

-- Create exactly one legacy stay for each current vehicle row. This preserves current
-- production semantics while giving every existing record an immutable stay UUID.
insert into public.vehicle_stays(
  vehicle_id,
  normalized_plate,
  stay_code,
  sequence_on_day,
  started_at,
  delivered_at,
  status,
  history_purge_eligible_at
)
select
  v.id,
  coalesce(v.normalized_plate, regexp_replace(upper(v.plate), '[^A-Z0-9]', '', 'g')),
  coalesce(v.normalized_plate, regexp_replace(upper(v.plate), '[^A-Z0-9]', '', 'g'))
    || '-' || to_char((v.created_at at time zone 'Europe/Madrid')::date, 'YYYYMMDD') || '-001',
  1,
  v.created_at,
  v.retrieved_at,
  case when v.status = 'retrieved' then 'delivered' else 'active' end,
  case
    when v.retrieved_at is not null then v.retrieved_at + make_interval(days => (select history_retention_days from public.data_retention_config where singleton_id = 1))
    else null
  end
from public.vehicles v
where not exists (
  select 1 from public.vehicle_stays s where s.vehicle_id = v.id
)
on conflict (stay_code) do nothing;

-- Disputes belong to a stay, not to the physical plate forever. Keep vehicle_id for
-- compatibility/reporting, but make stay_id the retention hold boundary.
alter table public.vehicle_disputes
  add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;

update public.vehicle_disputes d
set stay_id = s.id
from lateral (
  select vs.id
  from public.vehicle_stays vs
  where vs.vehicle_id = d.vehicle_id
  order by vs.started_at desc
  limit 1
) s
where d.stay_id is null;

alter table public.vehicle_disputes
  alter column stay_id set not null;

drop index if exists public.vehicle_disputes_one_open_per_vehicle;
create unique index if not exists vehicle_disputes_one_open_per_stay
  on public.vehicle_disputes(stay_id)
  where status = 'open';
create index if not exists vehicle_disputes_stay_history_idx
  on public.vehicle_disputes(stay_id, opened_at desc);

-- Service-role helper for future operational integration. It allocates a readable code
-- while the UUID remains the true immutable identity.
create or replace function public.create_vehicle_stay(
  p_vehicle_id uuid,
  p_normalized_plate text,
  p_started_at timestamptz default now()
)
returns public.vehicle_stays
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plate text := regexp_replace(upper(coalesce(p_normalized_plate,'')), '[^A-Z0-9]', '', 'g');
  v_day date := (p_started_at at time zone 'Europe/Madrid')::date;
  v_seq integer;
  v_row public.vehicle_stays;
begin
  if length(v_plate) < 4 then
    raise exception 'invalid_plate';
  end if;

  perform 1 from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'vehicle_not_found'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_plate || ':' || v_day::text, 0));

  select coalesce(max(sequence_on_day), 0) + 1
    into v_seq
  from public.vehicle_stays
  where normalized_plate = v_plate
    and (started_at at time zone 'Europe/Madrid')::date = v_day;

  insert into public.vehicle_stays(
    vehicle_id, normalized_plate, stay_code, sequence_on_day, started_at, status
  ) values (
    p_vehicle_id,
    v_plate,
    v_plate || '-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0'),
    v_seq,
    p_started_at,
    'active'
  ) returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_vehicle_stay(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.create_vehicle_stay(uuid,text,timestamptz) to service_role;

create or replace function public.mark_vehicle_stay_delivered(
  p_stay_id uuid,
  p_delivered_at timestamptz default now()
)
returns public.vehicle_stays
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history_days integer;
  v_row public.vehicle_stays;
begin
  select history_retention_days into v_history_days
  from public.data_retention_config where singleton_id = 1;

  update public.vehicle_stays
  set delivered_at = p_delivered_at,
      status = 'delivered',
      history_purge_eligible_at = p_delivered_at + make_interval(days => v_history_days),
      updated_at = now()
  where id = p_stay_id
    and status <> 'purged'
  returning * into v_row;

  if v_row.id is null then raise exception 'stay_not_found_or_purged'; end if;
  return v_row;
end;
$$;

revoke all on function public.mark_vehicle_stay_delivered(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.mark_vehicle_stay_delivered(uuid,timestamptz) to service_role;

create or replace function public.stay_has_open_dispute(p_stay_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.vehicle_disputes d
    where d.stay_id = p_stay_id
      and d.status = 'open'
  );
$$;

revoke all on function public.stay_has_open_dispute(uuid) from public, anon, authenticated;
grant execute on function public.stay_has_open_dispute(uuid) to service_role;
