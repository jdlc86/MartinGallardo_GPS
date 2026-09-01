create or replace function public.sync_reservation_tasks_from_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pickup_at timestamptz;
  v_delivery_at timestamptz;
  v_vehicle_status text;
  v_pickup_completed_at timestamptz;
begin
  if new.deleted_at is not null then
    update public.reservation_tasks
    set status = 'cancelled',
        updated_at = now(),
        version = version + 1
    where booking_id = new.id
      and status <> 'completed';
    return new;
  end if;

  v_pickup_at := (new.pickup_date + new.pickup_time) at time zone 'Europe/Madrid';
  v_delivery_at := (new.return_date + new.return_time) at time zone 'Europe/Madrid';

  select v.status,
         (
           select max(e.created_at)
           from public.parking_events e
           where e.vehicle_id = v.id
             and e.operation = 'pickup'
         )
  into v_vehicle_status, v_pickup_completed_at
  from public.vehicles v
  where v.normalized_plate = new.vehicle_plate_normalized;

  insert into public.reservation_tasks as current_task (
    booking_id,
    task_type,
    scheduled_at,
    status
  )
  values (new.id, 'delivery', v_delivery_at, 'unassigned')
  on conflict (booking_id, task_type) do update
  set scheduled_at = excluded.scheduled_at,
      status = case
        when current_task.status = 'cancelled' then 'unassigned'
        else current_task.status
      end,
      updated_at = now(),
      version = current_task.version + 1;

  if v_vehicle_status in ('in_transit', 'parked') then
    update public.reservation_tasks
    set status = 'completed',
        completed_at = coalesce(completed_at, v_pickup_completed_at, clock_timestamp()),
        updated_at = now(),
        version = version + 1
    where booking_id = new.id
      and task_type = 'pickup'
      and status in ('unassigned', 'assigned');
  else
    insert into public.reservation_tasks as current_task (
      booking_id,
      task_type,
      scheduled_at,
      status
    )
    values (new.id, 'pickup', v_pickup_at, 'unassigned')
    on conflict (booking_id, task_type) do update
    set scheduled_at = excluded.scheduled_at,
        status = case
          when current_task.status = 'cancelled' then 'unassigned'
          else current_task.status
        end,
        updated_at = now(),
        version = current_task.version + 1;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_reservation_tasks_from_booking()
from public, anon, authenticated;

create or replace function public.reconcile_reservation_pickup_task_from_vehicle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('in_transit', 'parked') then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  -- Recogida ya se completó al pasar a in_transit. El cambio posterior
  -- in_transit -> parked no debe completar la recogida de una reserva futura.
  if tg_op = 'UPDATE' and old.status = 'in_transit' and new.status = 'parked' then
    return new;
  end if;

  update public.reservation_tasks task
  set status = 'completed',
      completed_at = coalesce(task.completed_at, clock_timestamp()),
      updated_at = now(),
      version = task.version + 1
  where task.id = (
    select candidate.id
    from public.reservation_tasks candidate
    join public.parking_bookings booking
      on booking.id = candidate.booking_id
    where booking.deleted_at is null
      and booking.vehicle_plate_normalized = new.normalized_plate
      and candidate.task_type = 'pickup'
      and candidate.status in ('unassigned', 'assigned')
    order by candidate.scheduled_at, candidate.created_at
    limit 1
  );

  return new;
end;
$$;

revoke all on function public.reconcile_reservation_pickup_task_from_vehicle()
from public, anon, authenticated;

drop trigger if exists trg_reconcile_reservation_pickup_task_from_vehicle
on public.vehicles;

create trigger trg_reconcile_reservation_pickup_task_from_vehicle
after insert or update of status
on public.vehicles
for each row
execute function public.reconcile_reservation_pickup_task_from_vehicle();

-- Repara tareas ya generadas cuando el vehículo fue recogido antes de la fecha.
update public.reservation_tasks task
set status = 'completed',
    completed_at = coalesce(
      task.completed_at,
      (
        select max(event.created_at)
        from public.parking_events event
        where event.vehicle_id = vehicle.id
          and event.operation = 'pickup'
      ),
      clock_timestamp()
    ),
    updated_at = now(),
    version = task.version + 1
from public.parking_bookings booking
join public.vehicles vehicle
  on vehicle.normalized_plate = booking.vehicle_plate_normalized
where task.booking_id = booking.id
  and booking.deleted_at is null
  and task.task_type = 'pickup'
  and task.status in ('unassigned', 'assigned')
  and vehicle.status in ('in_transit', 'parked');
