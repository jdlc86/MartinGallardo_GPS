-- Optimizer V2: durable asynchronous job infrastructure.
-- Non-breaking: legacy planner tables/functions remain untouched.

create table if not exists public.optimization_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by_telegram_user_id bigint not null,
  writer_epoch bigint not null,
  idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending','running','cancel_requested','succeeded','failed','cancelled')),
  solver_version text not null default 'optimizer_v2_cp_sat',
  horizon_start timestamptz not null,
  horizon_end timestamptz not null,
  request jsonb not null default '{}'::jsonb,
  input_snapshot jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  result_plan_id uuid references public.ai_dispatch_plans(id) on delete set null,
  error_code text,
  error_detail text,
  priority smallint not null default 100,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 10),
  claimed_by text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimization_jobs_horizon check (horizon_end > horizon_start),
  constraint optimization_jobs_idempotency_unique unique (created_by_telegram_user_id,idempotency_key)
);

create index if not exists optimization_jobs_queue_idx
  on public.optimization_jobs(status,priority,created_at)
  where status in ('pending','running','cancel_requested');
create index if not exists optimization_jobs_lease_idx on public.optimization_jobs(lease_until) where status='running';
create index if not exists optimization_jobs_actor_idx on public.optimization_jobs(created_by_telegram_user_id,created_at desc);

create table if not exists public.optimization_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.optimization_jobs(id) on delete cascade,
  stage text not null,
  level text not null default 'info' check (level in ('debug','info','warning','error')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists optimization_job_events_job_idx on public.optimization_job_events(job_id,id);

alter table public.optimization_jobs enable row level security;
alter table public.optimization_job_events enable row level security;
revoke all on table public.optimization_jobs from anon,authenticated;
revoke all on table public.optimization_job_events from anon,authenticated;
revoke all on sequence public.optimization_job_events_id_seq from anon,authenticated;

create or replace function public.claim_next_optimization_job(p_worker_id text,p_lease_seconds integer default 180)
returns public.optimization_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.optimization_jobs;
begin
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'worker_id_required'; end if;
  if p_lease_seconds<30 or p_lease_seconds>1800 then raise exception 'invalid_lease_seconds'; end if;
  with candidate as (
    select id from public.optimization_jobs
    where status='pending' or (status='running' and lease_until<now() and attempt<max_attempts)
    order by priority,created_at for update skip locked limit 1
  )
  update public.optimization_jobs j set status='running',claimed_by=p_worker_id,
    lease_until=now()+make_interval(secs=>p_lease_seconds),heartbeat_at=now(),
    started_at=coalesce(j.started_at,now()),attempt=j.attempt+1,updated_at=now(),error_code=null,error_detail=null
  from candidate c where j.id=c.id returning j.* into v_job;
  if v_job.id is not null then
    insert into public.optimization_job_events(job_id,stage,payload)
    values(v_job.id,'claimed',jsonb_build_object('worker_id',p_worker_id,'attempt',v_job.attempt));
  end if;
  return v_job;
end $$;

create or replace function public.heartbeat_optimization_job(p_job_id uuid,p_worker_id text,p_lease_seconds integer default 180,p_progress jsonb default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  update public.optimization_jobs set lease_until=now()+make_interval(secs=>p_lease_seconds),heartbeat_at=now(),
    progress=coalesce(p_progress,progress),updated_at=now()
  where id=p_job_id and status='running' and claimed_by=p_worker_id;
  get diagnostics n=row_count; return n=1;
end $$;

create or replace function public.complete_optimization_job(p_job_id uuid,p_worker_id text,p_result_plan_id uuid,p_metrics jsonb default '{}'::jsonb,p_progress jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  update public.optimization_jobs set status='succeeded',result_plan_id=p_result_plan_id,metrics=coalesce(p_metrics,'{}'::jsonb),
    progress=coalesce(p_progress,'{}'::jsonb),lease_until=null,heartbeat_at=now(),finished_at=now(),updated_at=now(),error_code=null,error_detail=null
  where id=p_job_id and status='running' and claimed_by=p_worker_id;
  get diagnostics n=row_count;
  if n=1 then insert into public.optimization_job_events(job_id,stage,payload)
    values(p_job_id,'completed',jsonb_build_object('worker_id',p_worker_id,'result_plan_id',p_result_plan_id)); end if;
  return n=1;
end $$;

create or replace function public.fail_optimization_job(p_job_id uuid,p_worker_id text,p_error_code text,p_error_detail text default null,p_retryable boolean default false,p_metrics jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer; s text;
begin
  select case when p_retryable and attempt<max_attempts then 'pending' else 'failed' end into s
  from public.optimization_jobs where id=p_job_id and status='running' and claimed_by=p_worker_id for update;
  if s is null then return false; end if;
  update public.optimization_jobs set status=s,error_code=p_error_code,error_detail=left(p_error_detail,4000),metrics=coalesce(p_metrics,'{}'::jsonb),
    claimed_by=case when s='pending' then null else claimed_by end,lease_until=null,heartbeat_at=now(),
    finished_at=case when s='failed' then now() else null end,updated_at=now()
  where id=p_job_id and status='running' and claimed_by=p_worker_id;
  get diagnostics n=row_count;
  if n=1 then insert into public.optimization_job_events(job_id,stage,level,payload)
    values(p_job_id,case when s='pending' then 'retry_scheduled' else 'failed' end,'error',jsonb_build_object('worker_id',p_worker_id,'error_code',p_error_code,'retryable',p_retryable)); end if;
  return n=1;
end $$;

create or replace function public.cancel_optimization_job(p_job_id uuid,p_actor_telegram_user_id bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  update public.optimization_jobs
  set status=case when status='pending' then 'cancelled' else 'cancel_requested' end,
      finished_at=case when status='pending' then now() else finished_at end,updated_at=now()
  where id=p_job_id and created_by_telegram_user_id=p_actor_telegram_user_id and status in ('pending','running');
  get diagnostics n=row_count;
  if n=1 then insert into public.optimization_job_events(job_id,stage,payload)
    values(p_job_id,'cancel_requested',jsonb_build_object('actor_telegram_user_id',p_actor_telegram_user_id)); end if;
  return n=1;
end $$;

revoke all on function public.claim_next_optimization_job(text,integer) from public,anon,authenticated;
revoke all on function public.heartbeat_optimization_job(uuid,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.complete_optimization_job(uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.fail_optimization_job(uuid,text,text,text,boolean,jsonb) from public,anon,authenticated;
revoke all on function public.cancel_optimization_job(uuid,bigint) from public,anon,authenticated;
grant execute on function public.claim_next_optimization_job(text,integer) to service_role;
grant execute on function public.heartbeat_optimization_job(uuid,text,integer,jsonb) to service_role;
grant execute on function public.complete_optimization_job(uuid,text,uuid,jsonb,jsonb) to service_role;
grant execute on function public.fail_optimization_job(uuid,text,text,text,boolean,jsonb) to service_role;
grant execute on function public.cancel_optimization_job(uuid,bigint) to service_role;
