alter table public.ai_dispatch_config
  add column if not exists global_work_mode text not null default 'max_effort',
  add column if not exists shift_start_hour integer not null default 6,
  add column if not exists shift_start_minute integer not null default 0,
  add column if not exists normal_shift_duration_minutes integer not null default 720,
  add column if not exists intensive_shift_duration_minutes integer not null default 1080,
  add column if not exists max_effort_shift_duration_minutes integer not null default 1320,
  add column if not exists normal_shift_cost integer not null default 0,
  add column if not exists intensive_shift_cost integer not null default 120,
  add column if not exists max_effort_shift_cost integer not null default 300;

alter table public.ai_dispatch_config
  drop constraint if exists ai_dispatch_config_global_work_mode_check,
  add constraint ai_dispatch_config_global_work_mode_check
    check (global_work_mode in ('normal','intensive','max_effort')),
  drop constraint if exists ai_dispatch_config_shift_start_hour_check,
  add constraint ai_dispatch_config_shift_start_hour_check
    check (shift_start_hour between 0 and 23),
  drop constraint if exists ai_dispatch_config_shift_start_minute_check,
  add constraint ai_dispatch_config_shift_start_minute_check
    check (shift_start_minute between 0 and 59),
  drop constraint if exists ai_dispatch_config_shift_durations_check,
  add constraint ai_dispatch_config_shift_durations_check
    check (
      normal_shift_duration_minutes > 0 and
      intensive_shift_duration_minutes >= normal_shift_duration_minutes and
      max_effort_shift_duration_minutes >= intensive_shift_duration_minutes and
      max_effort_shift_duration_minutes <= 1440
    );
