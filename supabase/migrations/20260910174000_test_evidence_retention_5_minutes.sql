-- TEMPORARY production test policy: purge delivered-stay evidence after 5 minutes.
-- Historical retention remains 365 days. Revert evidence interval to 15 days after E2E testing.

alter table public.data_retention_config
  add column if not exists evidence_retention_minutes integer null;

alter table public.data_retention_config
  drop constraint if exists data_retention_config_evidence_retention_minutes_check;
alter table public.data_retention_config
  add constraint data_retention_config_evidence_retention_minutes_check
  check (evidence_retention_minutes is null or evidence_retention_minutes >= 1);

update public.data_retention_config
set evidence_retention_minutes = 5,
    history_retention_days = 365,
    updated_at = now()
where singleton_id = 1;

create or replace function public.delivered_stay_retention_candidates(p_phase text, p_limit integer default 25)
returns table(stay_id uuid, vehicle_id uuid, normalized_plate text, stay_code text, delivered_at timestamptz, eligible_at timestamptz, storage_objects jsonb)
language sql stable security definer set search_path='' as $$
with cfg as (
  select evidence_retention_days,evidence_retention_minutes,history_retention_days
  from public.data_retention_config where singleton_id=1
)
select s.id,s.vehicle_id,s.normalized_plate,s.stay_code,s.delivered_at,
case when p_phase='evidence'
  then s.delivered_at + coalesce(make_interval(mins=>cfg.evidence_retention_minutes), make_interval(days=>cfg.evidence_retention_days))
  else s.delivered_at+make_interval(days=>cfg.history_retention_days) end,
case when p_phase='evidence' then coalesce((select jsonb_agg(jsonb_build_object('bucket',x.bucket,'path',x.path) order by x.bucket,x.path) from (select e.storage_bucket bucket,e.storage_path path from public.vehicle_evidence e where e.stay_id=s.id union all select p.storage_bucket,p.storage_path from public.vehicle_photos p where p.stay_id=s.id)x),'[]'::jsonb) else '[]'::jsonb end
from public.vehicle_stays s cross join cfg
where p_phase in ('evidence','history') and s.delivered_at is not null
and not exists(select 1 from public.vehicle_disputes d where d.stay_id=s.id and d.status='open')
and (s.retention_claim_token is null or s.retention_claimed_at<now()-interval '30 minutes')
and ((p_phase='evidence' and s.status='delivered' and s.evidence_purged_at is null and s.delivered_at + coalesce(make_interval(mins=>cfg.evidence_retention_minutes), make_interval(days=>cfg.evidence_retention_days)) <= now()) or (p_phase='history' and s.status in ('delivered','historical') and s.evidence_purged_at is not null and s.delivered_at+make_interval(days=>cfg.history_retention_days)<=now()))
order by s.delivered_at asc limit greatest(1,least(coalesce(p_limit,25),100));$$;

revoke all on function public.delivered_stay_retention_candidates(text,integer) from public,anon,authenticated;
grant execute on function public.delivered_stay_retention_candidates(text,integer) to service_role;
