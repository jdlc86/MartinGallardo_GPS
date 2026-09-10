-- Delivered-stay retention foundation. No automatic deletion is enabled by this migration.

alter table public.vehicle_stays add column if not exists retention_claim_token uuid null;
alter table public.vehicle_stays add column if not exists retention_claimed_at timestamptz null;
alter table public.vehicle_stays add column if not exists retention_claim_phase text null;
alter table public.vehicle_stays drop constraint if exists vehicle_stays_retention_claim_phase_check;
alter table public.vehicle_stays add constraint vehicle_stays_retention_claim_phase_check check (retention_claim_phase is null or retention_claim_phase in ('evidence','history'));

create or replace function public.delivered_stay_retention_candidates(p_phase text, p_limit integer default 25)
returns table(stay_id uuid, vehicle_id uuid, normalized_plate text, stay_code text, delivered_at timestamptz, eligible_at timestamptz, storage_objects jsonb)
language sql
stable
security definer
set search_path=''
as $$
  with cfg as (
    select evidence_retention_days,history_retention_days from public.data_retention_config where singleton_id=1
  )
  select s.id,s.vehicle_id,s.normalized_plate,s.stay_code,s.delivered_at,
    case when p_phase='evidence' then s.delivered_at + make_interval(days=>cfg.evidence_retention_days)
         else s.delivered_at + make_interval(days=>cfg.history_retention_days) end,
    case when p_phase='evidence' then coalesce((
      select jsonb_agg(jsonb_build_object('bucket',x.bucket,'path',x.path) order by x.bucket,x.path)
      from (
        select e.storage_bucket as bucket,e.storage_path as path from public.vehicle_evidence e where e.stay_id=s.id
        union all
        select p.storage_bucket,p.storage_path from public.vehicle_photos p where p.stay_id=s.id
      ) x
    ),'[]'::jsonb) else '[]'::jsonb end
  from public.vehicle_stays s cross join cfg
  where p_phase in ('evidence','history')
    and s.delivered_at is not null
    and not exists(select 1 from public.vehicle_disputes d where d.stay_id=s.id and d.status='open')
    and (s.retention_claim_token is null or s.retention_claimed_at < now()-interval '30 minutes')
    and ((p_phase='evidence' and s.status='delivered' and s.evidence_purged_at is null and s.delivered_at + make_interval(days=>cfg.evidence_retention_days) <= now())
      or (p_phase='history' and s.status in ('delivered','historical') and s.evidence_purged_at is not null and s.delivered_at + make_interval(days=>cfg.history_retention_days) <= now()))
  order by s.delivered_at asc
  limit greatest(1,least(coalesce(p_limit,25),100));
$$;
revoke all on function public.delivered_stay_retention_candidates(text,integer) from public,anon,authenticated;
grant execute on function public.delivered_stay_retention_candidates(text,integer) to service_role;

create or replace function public.claim_delivered_stay_retention(p_stay_id uuid,p_phase text,p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare c record;begin
  select * into c from public.delivered_stay_retention_candidates(p_phase,100) where stay_id=p_stay_id;
  if not found then return jsonb_build_object('claimed',false,'reason','not_eligible'); end if;
  update public.vehicle_stays set retention_claim_token=p_claim_token,retention_claimed_at=now(),retention_claim_phase=p_phase,updated_at=now()
  where id=p_stay_id and (retention_claim_token is null or retention_claimed_at < now()-interval '30 minutes');
  if not found then return jsonb_build_object('claimed',false,'reason','already_claimed'); end if;
  return jsonb_build_object('claimed',true,'storage_objects',c.storage_objects);
end;$$;
revoke all on function public.claim_delivered_stay_retention(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.claim_delivered_stay_retention(uuid,text,uuid) to service_role;

create or replace function public.release_delivered_stay_retention_claim(p_stay_id uuid,p_claim_token uuid)
returns boolean language sql security definer set search_path='' as $$
  update public.vehicle_stays set retention_claim_token=null,retention_claimed_at=null,retention_claim_phase=null,updated_at=now()
  where id=p_stay_id and retention_claim_token=p_claim_token returning true;
$$;
revoke all on function public.release_delivered_stay_retention_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_delivered_stay_retention_claim(uuid,uuid) to service_role;

create or replace function public.finalize_delivered_stay_evidence_purge(p_stay_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.vehicle_stays%rowtype;begin
  select * into s from public.vehicle_stays where id=p_stay_id for update;
  if not found or s.retention_claim_token<>p_claim_token or s.retention_claim_phase<>'evidence' then return jsonb_build_object('purged',false,'reason','claim_mismatch'); end if;
  if exists(select 1 from public.vehicle_disputes d where d.stay_id=s.id and d.status='open') then raise exception 'dispute_open'; end if;
  delete from public.vehicle_photos where stay_id=s.id;
  delete from public.vehicle_evidence where stay_id=s.id;
  update public.vehicle_share_links set revoked_at=coalesce(revoked_at,now()) where stay_id=s.id and revoked_at is null;
  update public.vehicle_stays set status='historical',evidence_purged_at=now(),retention_claim_token=null,retention_claimed_at=null,retention_claim_phase=null,updated_at=now() where id=s.id;
  return jsonb_build_object('purged',true);
end;$$;
revoke all on function public.finalize_delivered_stay_evidence_purge(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finalize_delivered_stay_evidence_purge(uuid,uuid) to service_role;

create or replace function public.finalize_delivered_stay_history_purge(p_stay_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.vehicle_stays%rowtype; v_deleted boolean:=false;begin
  select * into s from public.vehicle_stays where id=p_stay_id for update;
  if not found or s.retention_claim_token<>p_claim_token or s.retention_claim_phase<>'history' then return jsonb_build_object('purged',false,'reason','claim_mismatch'); end if;
  if exists(select 1 from public.vehicle_disputes d where d.stay_id=s.id and d.status='open') then raise exception 'dispute_open'; end if;
  if exists(select 1 from public.vehicle_evidence where stay_id=s.id) or exists(select 1 from public.vehicle_photos where stay_id=s.id) then raise exception 'evidence_not_purged'; end if;
  delete from public.vehicle_stays where id=s.id;
  if not exists(select 1 from public.vehicle_stays where vehicle_id=s.vehicle_id) then
    delete from public.vehicles where id=s.vehicle_id and status='retrieved';
    v_deleted:=found;
  end if;
  return jsonb_build_object('purged',true,'vehicle_deleted',v_deleted);
end;$$;
revoke all on function public.finalize_delivered_stay_history_purge(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finalize_delivered_stay_history_purge(uuid,uuid) to service_role;

create or replace function public.block_dispute_during_retention_cleanup()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='open' and exists(select 1 from public.vehicle_stays s where s.id=new.stay_id and s.retention_claim_token is not null and s.retention_claimed_at >= now()-interval '30 minutes') then
    raise exception 'retention_cleanup_in_progress';
  end if;
  return new;
end;$$;
drop trigger if exists vehicle_disputes_block_retention_race on public.vehicle_disputes;
create trigger vehicle_disputes_block_retention_race before insert or update of status,stay_id on public.vehicle_disputes for each row execute function public.block_dispute_during_retention_cleanup();

insert into public.maintenance_tasks(task_key,function_slug,enabled,priority,timeout_ms,config)
values
 ('purge_delivered_stay_evidence','delivered-stay-retention-cleanup',false,200,60000,'{"phase":"evidence","limit":25,"execute":false}'::jsonb),
 ('purge_delivered_stay_history','delivered-stay-retention-cleanup',false,300,60000,'{"phase":"history","limit":25,"execute":false}'::jsonb)
on conflict(task_key) do update set function_slug=excluded.function_slug,enabled=false,priority=excluded.priority,timeout_ms=excluded.timeout_ms,config=excluded.config,updated_at=now();
