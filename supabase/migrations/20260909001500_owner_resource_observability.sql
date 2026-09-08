-- Owner-only resource observability and internal budgets for ParkingMartin-G.
-- Phase 1 intentionally covers only metrics that are exact inside this project:
-- PostgreSQL database size and Supabase Storage object bytes/count.
-- No egress estimation and no automatic hard-stop behavior.

create table if not exists public.resource_observability_config (
  id boolean primary key default true check (id = true),
  database_budget_bytes bigint not null check (database_budget_bytes > 0),
  storage_budget_bytes bigint null check (storage_budget_bytes is null or storage_budget_bytes > 0),
  warning_percent numeric(5,2) not null default 80 check (warning_percent > 0 and warning_percent < 100),
  critical_percent numeric(5,2) not null default 90 check (critical_percent > warning_percent and critical_percent <= 100),
  updated_at timestamptz not null default now(),
  updated_by_telegram_user_id bigint null
);

alter table public.resource_observability_config enable row level security;

revoke all on table public.resource_observability_config from public, anon, authenticated;
grant all on table public.resource_observability_config to service_role;

insert into public.resource_observability_config(
  id,
  database_budget_bytes,
  storage_budget_bytes,
  warning_percent,
  critical_percent
)
select
  true,
  coalesce((select database_quota_bytes from public.database_health_config where id = true), 524288000),
  null,
  coalesce((select warning_percent from public.database_health_config where id = true), 80),
  coalesce((select critical_percent from public.database_health_config where id = true), 90)
on conflict (id) do nothing;

create or replace function public.resource_observability_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cfg public.resource_observability_config%rowtype;
  v_database_bytes bigint;
  v_storage_bytes bigint;
  v_storage_objects bigint;
  v_database_pct numeric;
  v_storage_pct numeric;
  v_database_status text := 'ok';
  v_storage_status text := 'unconfigured';
  v_overall_status text := 'ok';
begin
  select * into v_cfg
  from public.resource_observability_config
  where id = true;

  if not found then
    raise exception 'resource_observability_config_missing';
  end if;

  v_database_bytes := pg_database_size(current_database());

  select
    coalesce(sum(
      case
        when metadata ? 'size' and (metadata->>'size') ~ '^[0-9]+$'
          then (metadata->>'size')::bigint
        else 0
      end
    ), 0)::bigint,
    count(*)::bigint
  into v_storage_bytes, v_storage_objects
  from storage.objects;

  v_database_pct := round((v_database_bytes::numeric * 100) / nullif(v_cfg.database_budget_bytes, 0), 2);

  if v_database_pct >= v_cfg.critical_percent then
    v_database_status := 'critical';
  elsif v_database_pct >= v_cfg.warning_percent then
    v_database_status := 'warning';
  end if;

  if v_cfg.storage_budget_bytes is not null then
    v_storage_pct := round((v_storage_bytes::numeric * 100) / nullif(v_cfg.storage_budget_bytes, 0), 2);
    if v_storage_pct >= v_cfg.critical_percent then
      v_storage_status := 'critical';
    elsif v_storage_pct >= v_cfg.warning_percent then
      v_storage_status := 'warning';
    else
      v_storage_status := 'ok';
    end if;
  end if;

  if v_database_status = 'critical' or v_storage_status = 'critical' then
    v_overall_status := 'critical';
  elsif v_database_status = 'warning' or v_storage_status = 'warning' then
    v_overall_status := 'warning';
  elsif v_storage_status = 'unconfigured' then
    v_overall_status := 'needs_configuration';
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'overall_status', v_overall_status,
    'warning_percent', v_cfg.warning_percent,
    'critical_percent', v_cfg.critical_percent,
    'database', jsonb_build_object(
      'used_bytes', v_database_bytes,
      'budget_bytes', v_cfg.database_budget_bytes,
      'used_percent', v_database_pct,
      'status', v_database_status
    ),
    'storage', jsonb_build_object(
      'used_bytes', v_storage_bytes,
      'objects', v_storage_objects,
      'budget_bytes', v_cfg.storage_budget_bytes,
      'used_percent', v_storage_pct,
      'status', v_storage_status
    ),
    'updated_at', v_cfg.updated_at,
    'updated_by_telegram_user_id', v_cfg.updated_by_telegram_user_id
  );
end
$function$;

revoke all on function public.resource_observability_snapshot()
  from public, anon, authenticated;
grant execute on function public.resource_observability_snapshot()
  to service_role;
