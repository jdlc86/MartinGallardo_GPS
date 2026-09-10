-- ParkingMartin-G: transparently bind operational records to a vehicle stay.
-- Existing Edge Functions keep their current behaviour; the DB derives stay_id.

-- A physical vehicle may have many historical stays, but only one active stay.
create unique index if not exists vehicle_stays_one_active_per_vehicle
  on public.vehicle_stays(vehicle_id)
  where status = 'active';

-- Add stay ownership to all vehicle-scoped operational/evidence tables.
alter table public.operation_flow_sessions add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;
alter table public.parking_events add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;
alter table public.vehicle_evidence add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;
alter table public.plate_verifications add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;
alter table public.vehicle_photos add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;
alter table public.vehicle_share_links add column if not exists stay_id uuid null references public.vehicle_stays(id) on delete cascade;

create index if not exists operation_flow_sessions_stay_idx on public.operation_flow_sessions(stay_id);
create index if not exists parking_events_stay_idx on public.parking_events(stay_id, created_at);
create index if not exists vehicle_evidence_stay_idx on public.vehicle_evidence(stay_id, created_at);
create index if not exists plate_verifications_stay_idx on public.plate_verifications(stay_id, created_at);
create index if not exists vehicle_photos_stay_idx on public.vehicle_photos(stay_id, created_at);
create index if not exists vehicle_share_links_stay_idx on public.vehicle_share_links(stay_id);

-- Legacy data belongs to the single stay that was backfilled for each vehicle.
update public.operation_flow_sessions x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;
update public.parking_events x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;
update public.vehicle_evidence x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;
update public.plate_verifications x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;
update public.vehicle_photos x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;
update public.vehicle_share_links x set stay_id = s.id
from public.vehicle_stays s where x.stay_id is null and s.vehicle_id = x.vehicle_id;

-- All current rows have vehicle_id, therefore a stay must be present from now on.
alter table public.operation_flow_sessions alter column stay_id set not null;
alter table public.parking_events alter column stay_id set not null;
alter table public.vehicle_evidence alter column stay_id set not null;
alter table public.plate_verifications alter column stay_id set not null;
alter table public.vehicle_photos alter column stay_id set not null;
alter table public.vehicle_share_links alter column stay_id set not null;

-- Resolve the current stay for inserts made by existing application code.
create or replace function public.current_vehicle_stay_id(p_vehicle_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.vehicle_stays s
  where s.vehicle_id = p_vehicle_id
    and s.status <> 'purged'
  order by (s.status = 'active') desc, s.started_at desc
  limit 1;
$$;
revoke all on function public.current_vehicle_stay_id(uuid) from public, anon, authenticated;
grant execute on function public.current_vehicle_stay_id(uuid) to service_role;

create or replace function public.bind_current_vehicle_stay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stay_id is null then
    new.stay_id := public.current_vehicle_stay_id(new.vehicle_id);
  end if;
  if new.stay_id is null then
    raise exception 'vehicle_stay_not_found';
  end if;
  if not exists (
    select 1 from public.vehicle_stays s
    where s.id = new.stay_id and s.vehicle_id = new.vehicle_id
  ) then
    raise exception 'vehicle_stay_mismatch';
  end if;
  return new;
end;
$$;
revoke all on function public.bind_current_vehicle_stay() from public, anon, authenticated;

-- Existing APIs do not need to know about stay_id yet: the database fills it.
drop trigger if exists operation_flow_sessions_bind_stay on public.operation_flow_sessions;
create trigger operation_flow_sessions_bind_stay before insert or update of vehicle_id, stay_id on public.operation_flow_sessions
for each row execute function public.bind_current_vehicle_stay();
drop trigger if exists parking_events_bind_stay on public.parking_events;
create trigger parking_events_bind_stay before insert or update of vehicle_id, stay_id on public.parking_events
for each row execute function public.bind_current_vehicle_stay();
drop trigger if exists vehicle_evidence_bind_stay on public.vehicle_evidence;
create trigger vehicle_evidence_bind_stay before insert or update of vehicle_id, stay_id on public.vehicle_evidence
for each row execute function public.bind_current_vehicle_stay();
drop trigger if exists plate_verifications_bind_stay on public.plate_verifications;
create trigger plate_verifications_bind_stay before insert or update of vehicle_id, stay_id on public.plate_verifications
for each row execute function public.bind_current_vehicle_stay();
drop trigger if exists vehicle_photos_bind_stay on public.vehicle_photos;
create trigger vehicle_photos_bind_stay before insert or update of vehicle_id, stay_id on public.vehicle_photos
for each row execute function public.bind_current_vehicle_stay();
drop trigger if exists vehicle_share_links_bind_stay on public.vehicle_share_links;
create trigger vehicle_share_links_bind_stay before insert or update of vehicle_id, stay_id on public.vehicle_share_links
for each row execute function public.bind_current_vehicle_stay();

-- Keep the stay lifecycle synchronized with the existing vehicles state machine.
-- This is deliberately limited to INSERT, retrieved->requested and ->retrieved transitions.
create or replace function public.sync_vehicle_stay_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stay public.vehicle_stays;
  v_delivered_at timestamptz;
begin
  if tg_op = 'INSERT' then
    select * into v_stay
    from public.create_vehicle_stay(new.id, new.normalized_plate, coalesce(new.created_at, now()));
    if new.status = 'retrieved' then
      v_delivered_at := coalesce(new.retrieved_at, new.updated_at, now());
      perform public.mark_vehicle_stay_delivered(v_stay.id, v_delivered_at);
    end if;
    return new;
  end if;

  if old.status = 'retrieved' and new.status = 'requested' then
    -- A returned physical vehicle is a new parking stay, never a reactivation of history.
    perform public.create_vehicle_stay(new.id, new.normalized_plate, now());
    return new;
  end if;

  if old.status is distinct from 'retrieved' and new.status = 'retrieved' then
    select s.* into v_stay
    from public.vehicle_stays s
    where s.vehicle_id = new.id and s.status = 'active'
    order by s.started_at desc
    limit 1
    for update;
    if v_stay.id is null then raise exception 'active_vehicle_stay_not_found'; end if;
    v_delivered_at := coalesce(new.retrieved_at, now());
    perform public.mark_vehicle_stay_delivered(v_stay.id, v_delivered_at);
  end if;
  return new;
end;
$$;
revoke all on function public.sync_vehicle_stay_lifecycle() from public, anon, authenticated;

drop trigger if exists vehicles_sync_stay_lifecycle on public.vehicles;
create trigger vehicles_sync_stay_lifecycle
after insert or update of status on public.vehicles
for each row execute function public.sync_vehicle_stay_lifecycle();
