-- Optimizer V2 continuous 24/7 workforce policy.
-- Rest belongs to the policy chosen for the NEXT work block.

alter table if exists public.ai_dispatch_config
  add column if not exists normal_rest_minutes integer not null default 720,
  add column if not exists intensive_rest_minutes integer not null default 360,
  add column if not exists max_effort_rest_minutes integer not null default 120;

alter table if exists public.ai_dispatch_config
  drop constraint if exists ai_dispatch_config_normal_rest_minutes_check,
  drop constraint if exists ai_dispatch_config_intensive_rest_minutes_check,
  drop constraint if exists ai_dispatch_config_max_effort_rest_minutes_check;

alter table if exists public.ai_dispatch_config
  add constraint ai_dispatch_config_normal_rest_minutes_check check (normal_rest_minutes >= 0 and normal_rest_minutes <= 1440),
  add constraint ai_dispatch_config_intensive_rest_minutes_check check (intensive_rest_minutes >= 0 and intensive_rest_minutes <= 1440),
  add constraint ai_dispatch_config_max_effort_rest_minutes_check check (max_effort_rest_minutes >= 0 and max_effort_rest_minutes <= 1440);

comment on column public.ai_dispatch_config.normal_rest_minutes is
  'Minimum rest before a new Normal work block. Default 12h.';
comment on column public.ai_dispatch_config.intensive_rest_minutes is
  'Minimum rest before a new Intensive work block. Default 6h.';
comment on column public.ai_dispatch_config.max_effort_rest_minutes is
  'Minimum rest before a new Max Effort work block. Default 2h.';
