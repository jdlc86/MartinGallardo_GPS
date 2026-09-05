CREATE OR REPLACE FUNCTION public.get_daily_performance_report(p_date date)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with bounds as (
  select
    (p_date::timestamp at time zone 'Europe/Madrid') as start_ts,
    ((p_date + 1)::timestamp at time zone 'Europe/Madrid') as end_ts
), ops as (
  select
    w.id as worker_id,
    count(*) filter (where pe.operation = 'pickup')::int as pickups,
    count(*) filter (where pe.operation = 'park')::int as parks,
    count(*) filter (where pe.operation = 'relocate')::int as relocates,
    count(*) filter (where pe.operation = 'lookup')::int as lookups,
    count(*) filter (where pe.operation = 'retrieve')::int as retrieves,
    min(pe.created_at) as first_activity,
    max(pe.created_at) as last_activity
  from workers w
  cross join bounds b
  left join parking_events pe
    on pe.worker_id = w.id
   and pe.created_at >= b.start_ts
   and pe.created_at < b.end_ts
  group by w.id
), ocr as (
  select
    w.id as worker_id,
    count(*) filter (where pv.result = 'overridden')::int as ocr_overrides
  from workers w
  cross join bounds b
  left join plate_verifications pv
    on pv.worker_id = w.id
   and pv.created_at >= b.start_ts
   and pv.created_at < b.end_ts
  group by w.id
), base as (
  select
    tu.telegram_user_id,
    tu.role,
    coalesce(nullif(w.full_name,''), nullif(trim(concat_ws(' ',tu.first_name,tu.last_name)),''), tu.username, 'Usuario') as full_name,
    w.id as worker_id,
    coalesce(o.pickups,0) as pickups,
    coalesce(o.parks,0) as parks,
    coalesce(o.relocates,0) as relocates,
    coalesce(o.lookups,0) as lookups,
    coalesce(o.retrieves,0) as retrieves,
    coalesce(x.ocr_overrides,0) as ocr_overrides,
    o.first_activity,
    o.last_activity,
    exists(select 1 from worker_daily_presence p where p.worker_id=w.id and p.work_date=p_date) as location_shared
  from telegram_users tu
  join workers w on w.telegram_user_id = tu.telegram_user_id and w.active = true
  left join ops o on o.worker_id = w.id
  left join ocr x on x.worker_id = w.id
  where tu.active = true and tu.role in ('operario','admin','owner')
)
select coalesce(jsonb_agg(jsonb_build_object(
  'telegram_user_id', telegram_user_id,
  'role', role,
  'worker_id', worker_id,
  'full_name', full_name,
  'pickups', pickups,
  'parks', parks,
  'relocates', relocates,
  'lookups', lookups,
  'retrieves', retrieves,
  'ocr_overrides', ocr_overrides,
  'first_activity', first_activity,
  'last_activity', last_activity,
  'location_shared', location_shared,
  'total_operations', pickups + parks + relocates + lookups + retrieves
) order by full_name), '[]'::jsonb)
from base;
$function$
;
