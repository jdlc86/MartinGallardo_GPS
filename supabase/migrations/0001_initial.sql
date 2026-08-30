create extension if not exists pgcrypto;

create type public.user_role as enum ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');
create type public.user_status as enum ('PENDING', 'ACTIVE', 'DISABLED', 'REJECTED');

create table public.app_users (
    id uuid primary key default gen_random_uuid(),
    telegram_user_id bigint not null unique,
    telegram_username text,
    full_name text not null,
    phone text,
    role public.user_role not null default 'OPERATOR',
    status public.user_status not null default 'PENDING',
    approved_at timestamptz,
    approved_by uuid references public.app_users(id),
    disabled_at timestamptz,
    disabled_by uuid references public.app_users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.audit_events (
    id bigint generated always as identity primary key,
    actor_user_id uuid references public.app_users(id),
    action text not null,
    entity_type text not null,
    entity_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index audit_events_actor_idx on public.audit_events(actor_user_id, created_at desc);
create index audit_events_entity_idx on public.audit_events(entity_type, entity_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_users_set_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

-- La aplicación usa una conexión PostgreSQL privada desde el backend.
-- No se exponen estas tablas directamente al cliente Telegram/Mini App.
alter table public.app_users enable row level security;
alter table public.audit_events enable row level security;
