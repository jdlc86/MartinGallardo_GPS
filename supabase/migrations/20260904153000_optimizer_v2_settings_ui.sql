-- Optimizer V2 Phase 1 persistent configuration used by the Mini App settings screen.
alter table public.ai_dispatch_config
  add column if not exists normal_rest_minutes integer not null default 720,
  add column if not exists intensive_rest_minutes integer not null default 360,
  add column if not exists max_effort_rest_minutes integer not null default 120,
  add column if not exists company_shuttle_vehicle_count integer not null default 1,
  add column if not exists company_shuttle_passenger_capacity integer not null default 4,
  add column if not exists company_shuttle_mission_cost integer not null default 500,
  add column if not exists back_forward_mode text not null default 'fast',
  add column if not exists back_forward_window_minutes integer not null default 1440,
  add column if not exists back_forward_overlap_minutes integer not null default 360,
  add column if not exists back_forward_candidate_step_minutes integer not null default 60,
  add column if not exists back_forward_max_anchor_candidates integer not null default 12,
  add column if not exists back_forward_optimal_explore_ratio numeric not null default 0.35,
  add column if not exists optimizer_time_limit_seconds numeric not null default 120;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='ai_dispatch_config_back_forward_mode_check') then
    alter table public.ai_dispatch_config
      add constraint ai_dispatch_config_back_forward_mode_check
      check (back_forward_mode in ('fast','optimal'));
  end if;
  if not exists (select 1 from pg_constraint where conname='ai_dispatch_config_work_mode_check') then
    alter table public.ai_dispatch_config
      add constraint ai_dispatch_config_work_mode_check
      check (global_work_mode in ('normal','intensive','max_effort'));
  end if;
  if not exists (select 1 from pg_constraint where conname='ai_dispatch_config_optimizer_values_check') then
    alter table public.ai_dispatch_config
      add constraint ai_dispatch_config_optimizer_values_check
      check (
        normal_rest_minutes between 0 and 2880 and
        intensive_rest_minutes between 0 and 2880 and
        max_effort_rest_minutes between 0 and 2880 and
        company_shuttle_vehicle_count between 0 and 20 and
        company_shuttle_passenger_capacity between 1 and 20 and
        back_forward_window_minutes between 60 and 10080 and
        back_forward_overlap_minutes between 0 and 5039 and
        back_forward_overlap_minutes < back_forward_window_minutes and
        back_forward_candidate_step_minutes between 5 and 1440 and
        back_forward_max_anchor_candidates between 1 and 100 and
        back_forward_optimal_explore_ratio between 0.05 and 0.90 and
        optimizer_time_limit_seconds between 10 and 900
      );
  end if;
end $$;
