-- Global maintenance orchestration registry.
create table if not exists public.maintenance_tasks (
  task_key text primary key,
  function_slug text not null unique,
  enabled boolean not null default true,
  priority integer not null default 100,
  timeout_ms integer not null default 20000 check (timeout_ms between 1000 and 120000),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.maintenance_runner_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running' check (status in ('running','success','partial_failure','failed')),
  tasks_total integer not null default 0,
  tasks_succeeded integer not null default 0,
  tasks_failed integer not null default 0,
  details jsonb not null default '[]'::jsonb
);
alter table public.maintenance_tasks enable row level security;
alter table public.maintenance_runner_runs enable row level security;
revoke all on table public.maintenance_tasks from anon, authenticated;
revoke all on table public.maintenance_runner_runs from anon, authenticated;
grant select on table public.maintenance_tasks to service_role;
grant select,insert,update on table public.maintenance_runner_runs to service_role;

insert into public.maintenance_tasks(task_key,function_slug,enabled,priority,timeout_ms,config)
values('cleanup_aborted_flows','aborted-vehicle-cleanup',true,100,20000,'{"limit":25}'::jsonb)
on conflict(task_key) do update set
  function_slug=excluded.function_slug,
  enabled=excluded.enabled,
  priority=excluded.priority,
  timeout_ms=excluded.timeout_ms,
  config=excluded.config,
  updated_at=now();

do $$
begin
  if not exists(select 1 from vault.secrets where name='maintenance_runner_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'maintenance_runner_secret','Auth secret for global maintenance runner cron');
  end if;
end $$;

create or replace function public.validate_maintenance_runner_secret(p_secret text)
returns boolean language sql security definer
set search_path=public,vault,pg_temp
as $$
  select exists(
    select 1 from vault.decrypted_secrets
    where name='maintenance_runner_secret' and decrypted_secret=p_secret
  );
$$;
revoke all on function public.validate_maintenance_runner_secret(text) from public,anon,authenticated;
grant execute on function public.validate_maintenance_runner_secret(text) to service_role;
