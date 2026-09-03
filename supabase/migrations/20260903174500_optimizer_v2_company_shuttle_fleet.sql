-- Configurable rescue/company shuttle fleet for Optimizer V2.
-- Vehicles are driven by non-operator company staff, carry operators as passengers,
-- and every mission must start and finish at PARKING.

alter table public.ai_dispatch_config
  add column if not exists company_shuttle_vehicle_count integer not null default 1,
  add column if not exists company_shuttle_passenger_capacity integer not null default 4,
  add column if not exists company_shuttle_mission_cost integer not null default 500;

alter table public.ai_dispatch_config
  drop constraint if exists ai_dispatch_config_company_shuttle_vehicle_count_check,
  add constraint ai_dispatch_config_company_shuttle_vehicle_count_check
    check (company_shuttle_vehicle_count >= 0 and company_shuttle_vehicle_count <= 50),
  drop constraint if exists ai_dispatch_config_company_shuttle_passenger_capacity_check,
  add constraint ai_dispatch_config_company_shuttle_passenger_capacity_check
    check (company_shuttle_passenger_capacity >= 1 and company_shuttle_passenger_capacity <= 20),
  drop constraint if exists ai_dispatch_config_company_shuttle_mission_cost_check,
  add constraint ai_dispatch_config_company_shuttle_mission_cost_check
    check (company_shuttle_mission_cost >= 0);

comment on column public.ai_dispatch_config.company_shuttle_vehicle_count is
  'Number of company rescue/shuttle vehicles available to optimizer. 0 disables the resource.';
comment on column public.ai_dispatch_config.company_shuttle_passenger_capacity is
  'Maximum operator passengers per company shuttle vehicle; driver is external and not counted.';
comment on column public.ai_dispatch_config.company_shuttle_mission_cost is
  'Secondary objective penalty per rescue mission; coverage remains lexicographically primary.';
