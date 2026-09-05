-- Automated cleanup infrastructure for aborted provisional parking vehicles.
alter table public.vehicles
  add column if not exists cleanup_claim_token uuid null,
  add column if not exists cleanup_claimed_at timestamptz null;

create table if not exists public.maintenance_cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  cleanup_type text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  candidates integer not null default 0,
  deleted integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,
  details jsonb not null default '[]'::jsonb
);
alter table public.maintenance_cleanup_runs enable row level security;
revoke all on table public.maintenance_cleanup_runs from anon, authenticated;
grant select,insert,update on table public.maintenance_cleanup_runs to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name='aborted_vehicle_cleanup_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'aborted_vehicle_cleanup_secret','Auth secret for aborted provisional vehicle cleanup cron');
  end if;
end $$;

create or replace function public.validate_aborted_vehicle_cleanup_secret(p_secret text)
returns boolean language sql security definer set search_path=public,vault,pg_temp as $$
  select exists(select 1 from vault.decrypted_secrets where name='aborted_vehicle_cleanup_secret' and decrypted_secret=p_secret);
$$;
revoke all on function public.validate_aborted_vehicle_cleanup_secret(text) from public,anon,authenticated;
grant execute on function public.validate_aborted_vehicle_cleanup_secret(text) to service_role;

create or replace function public.aborted_vehicle_cleanup_candidates(p_limit integer default 25)
returns table(vehicle_id uuid,normalized_plate text,cleanup_eligible_at timestamptz,storage_paths text[])
language sql security definer set search_path=public,pg_temp as $$
  select v.id,v.normalized_plate,v.cleanup_eligible_at,
    coalesce(array_agg(ve.storage_path order by ve.created_at) filter(where ve.storage_path is not null),'{}'::text[])
  from public.vehicles v
  left join public.vehicle_evidence ve on ve.vehicle_id=v.id
  where v.aborted_at is not null and v.cleanup_eligible_at is not null and v.cleanup_eligible_at<=now()
    and v.cleanup_reason='cancelled_initial_parking' and v.status='in_transit'
    and v.parked_at is null and v.retrieved_at is null
    and not exists(select 1 from public.parking_events pe where pe.vehicle_id=v.id)
    and not exists(select 1 from public.vehicle_photos vp where vp.vehicle_id=v.id)
    and not exists(select 1 from public.vehicle_share_links sl where sl.vehicle_id=v.id)
    and not exists(select 1 from public.operation_flow_sessions s where s.vehicle_id=v.id and s.status<>'cancelled')
  group by v.id,v.normalized_plate,v.cleanup_eligible_at
  order by v.cleanup_eligible_at,v.id
  limit greatest(1,least(coalesce(p_limit,25),100));
$$;

create or replace function public.claim_aborted_vehicle_cleanup(p_vehicle_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.vehicles%rowtype; paths text[];
begin
  select * into v from public.vehicles where id=p_vehicle_id for update;
  if not found then return jsonb_build_object('ok',true,'claimed',false,'reason','not_found'); end if;
  if v.aborted_at is null or v.cleanup_eligible_at is null or v.cleanup_eligible_at>now()
     or v.cleanup_reason<>'cancelled_initial_parking' or v.status<>'in_transit'
     or v.parked_at is not null or v.retrieved_at is not null
     or exists(select 1 from public.parking_events pe where pe.vehicle_id=v.id)
     or exists(select 1 from public.vehicle_photos vp where vp.vehicle_id=v.id)
     or exists(select 1 from public.vehicle_share_links sl where sl.vehicle_id=v.id)
     or exists(select 1 from public.operation_flow_sessions s where s.vehicle_id=v.id and s.status<>'cancelled')
  then return jsonb_build_object('ok',true,'claimed',false,'reason','no_longer_eligible'); end if;
  if v.cleanup_claim_token is not null and v.cleanup_claimed_at>now()-interval '30 minutes'
  then return jsonb_build_object('ok',true,'claimed',false,'reason','already_claimed'); end if;
  select coalesce(array_agg(storage_path order by created_at) filter(where storage_path is not null),'{}'::text[])
    into paths from public.vehicle_evidence where vehicle_id=v.id;
  update public.vehicles set cleanup_claim_token=p_claim_token,cleanup_claimed_at=now(),updated_at=now() where id=v.id;
  return jsonb_build_object('ok',true,'claimed',true,'vehicle_id',v.id,'plate',v.normalized_plate,'storage_paths',to_jsonb(paths));
end $$;

create or replace function public.delete_aborted_vehicle_if_still_eligible(p_vehicle_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where id=p_vehicle_id for update;
  if not found then return jsonb_build_object('ok',true,'deleted',false,'reason','not_found'); end if;
  if v.cleanup_claim_token is distinct from p_claim_token or v.cleanup_claimed_at is null or v.cleanup_claimed_at<now()-interval '30 minutes'
  then return jsonb_build_object('ok',true,'deleted',false,'reason','invalid_claim'); end if;
  if v.aborted_at is null or v.cleanup_eligible_at is null or v.cleanup_eligible_at>now()
     or v.cleanup_reason<>'cancelled_initial_parking' or v.status<>'in_transit'
     or v.parked_at is not null or v.retrieved_at is not null
     or exists(select 1 from public.parking_events pe where pe.vehicle_id=v.id)
     or exists(select 1 from public.vehicle_photos vp where vp.vehicle_id=v.id)
     or exists(select 1 from public.vehicle_share_links sl where sl.vehicle_id=v.id)
     or exists(select 1 from public.operation_flow_sessions s where s.vehicle_id=v.id and s.status<>'cancelled')
  then
    update public.vehicles set cleanup_claim_token=null,cleanup_claimed_at=null,updated_at=now() where id=v.id;
    return jsonb_build_object('ok',true,'deleted',false,'reason','no_longer_eligible');
  end if;
  delete from public.operation_flow_sessions where vehicle_id=v.id and status='cancelled';
  delete from public.vehicles where id=v.id;
  return jsonb_build_object('ok',true,'deleted',true,'vehicle_id',v.id,'plate',v.normalized_plate);
end $$;

create or replace function public.release_aborted_vehicle_cleanup_claim(p_vehicle_id uuid,p_claim_token uuid)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  update public.vehicles set cleanup_claim_token=null,cleanup_claimed_at=null,updated_at=now()
  where id=p_vehicle_id and cleanup_claim_token=p_claim_token returning true;
$$;

revoke all on function public.aborted_vehicle_cleanup_candidates(integer) from public,anon,authenticated;
revoke all on function public.claim_aborted_vehicle_cleanup(uuid,uuid) from public,anon,authenticated;
revoke all on function public.delete_aborted_vehicle_if_still_eligible(uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_aborted_vehicle_cleanup_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.aborted_vehicle_cleanup_candidates(integer) to service_role;
grant execute on function public.claim_aborted_vehicle_cleanup(uuid,uuid) to service_role;
grant execute on function public.delete_aborted_vehicle_if_still_eligible(uuid,uuid) to service_role;
grant execute on function public.release_aborted_vehicle_cleanup_claim(uuid,uuid) to service_role;
