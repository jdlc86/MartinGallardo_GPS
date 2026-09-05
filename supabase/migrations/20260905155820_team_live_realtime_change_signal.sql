create or replace function public.broadcast_worker_live_location_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform realtime.send(
    jsonb_build_object('changed', true),
    'changed',
    'team-live-locations',
    false
  );
  return coalesce(new, old);
end;
$function$;

revoke all on function public.broadcast_worker_live_location_change() from public, anon, authenticated;

drop trigger if exists trg_worker_live_location_realtime on public.worker_live_locations;
create trigger trg_worker_live_location_realtime
after insert or update or delete on public.worker_live_locations
for each row execute function public.broadcast_worker_live_location_change();
