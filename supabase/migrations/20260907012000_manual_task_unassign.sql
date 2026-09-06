create or replace function public.reservation_task_bulk_unassign(
  p_actor_telegram_user_id bigint,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor_role text;
  item jsonb;
  task_rec public.reservation_tasks%rowtype;
  changes jsonb := '[]'::jsonb;
begin
  select role into actor_role
  from public.telegram_users
  where telegram_user_id=p_actor_telegram_user_id
    and active=true;

  if actor_role not in ('owner','admin') then
    raise exception 'not_admin';
  end if;

  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'empty_task_selection';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    select * into task_rec
    from public.reservation_tasks
    where id=(item->>'id')::uuid
    for update;

    if not found or task_rec.status in ('completed','cancelled') then
      raise exception 'task_not_assignable';
    end if;

    if task_rec.version <> (item->>'version')::bigint then
      raise exception 'task_assignment_conflict';
    end if;

    if task_rec.assigned_worker_id is null then
      continue;
    end if;

    insert into public.reservation_task_assignment_history(
      task_id, previous_worker_id, new_worker_id,
      changed_by_telegram_user_id, reason
    )
    values(
      task_rec.id,
      task_rec.assigned_worker_id,
      null,
      p_actor_telegram_user_id,
      'unassignment'
    );

    update public.reservation_tasks
    set assigned_worker_id=null,
        assigned_at=null,
        assigned_by_telegram_user_id=null,
        status='unassigned',
        updated_at=now(),
        version=version+1
    where id=task_rec.id;

    changes:=changes||jsonb_build_array(jsonb_build_object(
      'task_id',task_rec.id,
      'previous_worker_id',task_rec.assigned_worker_id,
      'new_worker_id',null,
      'task_type',task_rec.task_type
    ));
  end loop;

  return jsonb_build_object('changes',changes);
end
$function$;

revoke all on function public.reservation_task_bulk_unassign(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.reservation_task_bulk_unassign(bigint, jsonb)
  to service_role;
