create or replace function public.ai_dispatch_confirm_plan(
  p_actor_telegram_user_id bigint,
  p_plan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor_role text;
  plan_rec public.ai_dispatch_plans%rowtype;
  item jsonb;
  task_rec public.reservation_tasks%rowtype;
  target_rec public.workers%rowtype;
  fixed_id_text text;
  expected_version bigint;
  changes jsonb := '[]'::jsonb;
  assigned_count integer := 0;
  new_notification_count integer := 0;
  reassignment_notification_count integer := 0;
begin
  select role into actor_role
  from public.telegram_users
  where telegram_user_id = p_actor_telegram_user_id
    and active = true;

  if actor_role not in ('owner','admin') then
    raise exception 'not_admin';
  end if;

  select * into plan_rec
  from public.ai_dispatch_plans
  where id = p_plan_id
    and created_by_telegram_user_id = p_actor_telegram_user_id
  for update;

  if not found then raise exception 'plan_not_found'; end if;
  if plan_rec.status <> 'proposal' then raise exception 'plan_not_proposal'; end if;

  perform public.parking_booking_require_writer(
    p_actor_telegram_user_id,
    plan_rec.writer_epoch
  );

  if coalesce((plan_rec.plan->>'physical_feasible')::boolean, false) is not true then
    raise exception 'plan_not_physically_feasible';
  end if;

  if jsonb_typeof(coalesce(plan_rec.plan->'assignments','[]'::jsonb)) <> 'array' then
    raise exception 'invalid_plan_assignments';
  end if;

  for fixed_id_text in
    select jsonb_array_elements_text(coalesce(plan_rec.plan->'fixed_task_ids','[]'::jsonb))
  loop
    expected_version := nullif(plan_rec.input_snapshot->'task_versions'->>fixed_id_text,'')::bigint;
    select * into task_rec
    from public.reservation_tasks
    where id = fixed_id_text::uuid
    for update;

    if not found or expected_version is null or task_rec.version <> expected_version then
      raise exception 'manual_assignment_changed';
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(plan_rec.plan->'assignments','[]'::jsonb))
  loop
    select * into task_rec
    from public.reservation_tasks
    where id = (item->>'task_id')::uuid
    for update;

    if not found or task_rec.status in ('completed','cancelled') then
      raise exception 'task_not_assignable';
    end if;

    if task_rec.version <> (item->>'version')::bigint then
      raise exception 'task_assignment_conflict';
    end if;

    select * into target_rec
    from public.workers
    where id = (item->>'worker_id')::uuid
      and active = true;

    if not found then raise exception 'target_worker_inactive'; end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(plan_rec.plan->'assignments','[]'::jsonb))
  loop
    select * into task_rec
    from public.reservation_tasks
    where id = (item->>'task_id')::uuid;

    insert into public.reservation_task_assignment_history(
      task_id, previous_worker_id, new_worker_id,
      changed_by_telegram_user_id, reason
    )
    values(
      task_rec.id,
      task_rec.assigned_worker_id,
      (item->>'worker_id')::uuid,
      p_actor_telegram_user_id,
      case when task_rec.assigned_worker_id is null
        then 'optimizer_plan_confirmation'
        else 'optimizer_plan_reassignment'
      end
    );

    update public.reservation_tasks
    set assigned_worker_id = (item->>'worker_id')::uuid,
        assigned_at = now(),
        assigned_by_telegram_user_id = p_actor_telegram_user_id,
        status = 'assigned',
        updated_at = now(),
        version = version + 1
    where id = task_rec.id;

    changes := changes || jsonb_build_array(
      jsonb_build_object(
        'task_id', task_rec.id,
        'previous_worker_id', task_rec.assigned_worker_id,
        'new_worker_id', (item->>'worker_id')::uuid,
        'task_type', task_rec.task_type
      )
    );
    assigned_count := assigned_count + 1;
  end loop;

  with assignment_details as (
    select
      (c.value->>'new_worker_id')::uuid as worker_id,
      w.telegram_user_id,
      t.id as task_id,
      t.task_type,
      t.scheduled_at,
      case when t.task_type='pickup' then b.pickup_terminal else b.return_terminal end as terminal,
      b.vehicle_plate as plate,
      row_number() over (
        partition by (c.value->>'new_worker_id')::uuid
        order by t.scheduled_at, t.id
      ) as rn,
      count(*) over (
        partition by (c.value->>'new_worker_id')::uuid
      ) as total_count
    from jsonb_array_elements(changes) c(value)
    join public.reservation_tasks t on t.id=(c.value->>'task_id')::uuid
    join public.parking_bookings b on b.id=t.booking_id
    join public.workers w on w.id=(c.value->>'new_worker_id')::uuid
    where w.telegram_user_id is not null
  ),
  grouped as (
    select
      worker_id,
      telegram_user_id,
      max(total_count)::integer as total_count,
      string_agg(
        case when rn <= 8 then
          (case when task_type='pickup' then '✈️ Recogida' else '🏁 Entrega' end)
          || ' · ' || to_char(scheduled_at at time zone 'Europe/Madrid','DD/MM HH24:MI')
          || ' · ' || coalesce(nullif(terminal,''),'Terminal —')
          || ' · ' || coalesce(nullif(plate,''),'—')
        end,
        E'\n' order by scheduled_at, task_id
      ) filter (where rn <= 8) as task_lines,
      jsonb_agg(task_id order by scheduled_at, task_id) as task_ids
    from assignment_details
    group by worker_id, telegram_user_id
  )
  insert into public.parking_booking_notifications(
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  select
    telegram_user_id,
    'task_assignment',
    'Nuevas asignaciones',
    total_count::text
      || case when total_count=1 then ' tarea asignada' else ' tareas asignadas' end
      || ' a tu agenda.'
      || E'\n\n'
      || coalesce(task_lines,'')
      || case when total_count>8 then E'\n… y ' || (total_count-8)::text || ' más.' else '' end,
    jsonb_build_object(
      'plan_id', plan_rec.id,
      'task_ids', task_ids,
      'source', 'optimizer_plan_confirmation'
    )
  from grouped;

  get diagnostics new_notification_count = row_count;

  with reassignment_details as (
    select
      (c.value->>'previous_worker_id')::uuid as worker_id,
      w.telegram_user_id,
      t.id as task_id,
      t.task_type,
      t.scheduled_at,
      case when t.task_type='pickup' then b.pickup_terminal else b.return_terminal end as terminal,
      b.vehicle_plate as plate,
      row_number() over (
        partition by (c.value->>'previous_worker_id')::uuid
        order by t.scheduled_at, t.id
      ) as rn,
      count(*) over (
        partition by (c.value->>'previous_worker_id')::uuid
      ) as total_count
    from jsonb_array_elements(changes) c(value)
    join public.reservation_tasks t on t.id=(c.value->>'task_id')::uuid
    join public.parking_bookings b on b.id=t.booking_id
    join public.workers w on w.id=(c.value->>'previous_worker_id')::uuid
    where c.value->>'previous_worker_id' is not null
      and (c.value->>'previous_worker_id') <> (c.value->>'new_worker_id')
      and w.telegram_user_id is not null
  ),
  grouped as (
    select
      worker_id,
      telegram_user_id,
      max(total_count)::integer as total_count,
      string_agg(
        case when rn <= 8 then
          (case when task_type='pickup' then '✈️ Recogida' else '🏁 Entrega' end)
          || ' · ' || to_char(scheduled_at at time zone 'Europe/Madrid','DD/MM HH24:MI')
          || ' · ' || coalesce(nullif(terminal,''),'Terminal —')
          || ' · ' || coalesce(nullif(plate,''),'—')
        end,
        E'\n' order by scheduled_at, task_id
      ) filter (where rn <= 8) as task_lines,
      jsonb_agg(task_id order by scheduled_at, task_id) as task_ids
    from reassignment_details
    group by worker_id, telegram_user_id
  )
  insert into public.parking_booking_notifications(
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  select
    telegram_user_id,
    'task_reassignment',
    'Cambio de asignación',
    total_count::text
      || case when total_count=1 then ' tarea ha sido reasignada' else ' tareas han sido reasignadas' end
      || ' a otro operario.'
      || E'\n\n'
      || coalesce(task_lines,'')
      || case when total_count>8 then E'\n… y ' || (total_count-8)::text || ' más.' else '' end,
    jsonb_build_object(
      'plan_id', plan_rec.id,
      'task_ids', task_ids,
      'source', 'optimizer_plan_reassignment'
    )
  from grouped;

  get diagnostics reassignment_notification_count = row_count;

  update public.ai_dispatch_plans
  set status = 'confirmed'
  where id = plan_rec.id;

  return jsonb_build_object(
    'plan_id', plan_rec.id,
    'assigned', assigned_count,
    'notifications_queued', new_notification_count + reassignment_notification_count,
    'assignment_notifications_queued', new_notification_count,
    'reassignment_notifications_queued', reassignment_notification_count,
    'changes', changes,
    'status', 'confirmed'
  );
end
$function$;

revoke all on function public.ai_dispatch_confirm_plan(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.ai_dispatch_confirm_plan(bigint, uuid)
  to service_role;
