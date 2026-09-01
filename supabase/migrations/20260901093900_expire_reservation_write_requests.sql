create or replace function public.parking_booking_expire_permission_requests()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expired record;
  v_count integer := 0;
begin
  for v_expired in
    update public.parking_booking_permission_requests
    set status = 'expired', responded_at = now()
    where status = 'pending' and expires_at <= now()
    returning id, requester_telegram_user_id
  loop
    v_count := v_count + 1;
    insert into public.parking_booking_notifications(recipient_telegram_user_id, notification_type, title, body, permission_request_id)
    values (v_expired.requester_telegram_user_id, 'permission_expired', 'Solicitud caducada',
            'La solicitud de Lectura/Escritura ha caducado sin respuesta.', v_expired.id);
  end loop;
  return v_count;
end;
$$;

create or replace function public.parking_booking_repair_writer_after_admin_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_replacement bigint;
  v_state public.parking_booking_write_state%rowtype;
  v_expired record;
begin
  if new.active = true and new.role in ('owner', 'admin') then return new; end if;
  select * into v_state from public.parking_booking_write_state where id = 1 for update;
  if v_state.holder_telegram_user_id is distinct from new.telegram_user_id then return new; end if;

  select telegram_user_id into v_replacement
  from public.telegram_users
  where active = true and role = 'owner' and telegram_user_id <> new.telegram_user_id
  order by created_at limit 1;
  if v_replacement is null then
    select telegram_user_id into v_replacement
    from public.telegram_users
    where active = true and role = 'admin' and telegram_user_id <> new.telegram_user_id
    order by created_at limit 1;
  end if;

  update public.parking_booking_write_state
  set holder_telegram_user_id = v_replacement,
      epoch = epoch + 1,
      granted_by_telegram_user_id = null,
      granted_at = now(),
      updated_at = now()
  where id = 1;
  for v_expired in
    update public.parking_booking_permission_requests
    set status = 'expired', responded_at = now()
    where status = 'pending'
    returning id, requester_telegram_user_id
  loop
    insert into public.parking_booking_notifications(recipient_telegram_user_id, notification_type, title, body, permission_request_id)
    values (v_expired.requester_telegram_user_id, 'permission_expired', 'Solicitud caducada',
            'La solicitud ha caducado porque cambió el titular de Lectura/Escritura.', v_expired.id);
  end loop;
  insert into public.parking_booking_admin_events(actor_telegram_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (null, 'repair_writer', 'write_permission', coalesce(v_replacement::text, 'none'), to_jsonb(v_state),
          jsonb_build_object('holder_telegram_user_id', v_replacement, 'epoch', v_state.epoch + 1),
          jsonb_build_object('reason', 'holder_no_longer_active_admin'));
  if v_replacement is not null then
    insert into public.parking_booking_notifications(recipient_telegram_user_id, notification_type, title, body)
    values (v_replacement, 'permission_recovered', 'Permiso de escritura recuperado',
            'El sistema te ha asignado Lectura/Escritura porque el titular anterior dejó de ser administrador activo.');
  end if;
  return new;
end;
$$;

revoke execute on function public.parking_booking_expire_permission_requests() from public, anon, authenticated;
revoke execute on function public.parking_booking_repair_writer_after_admin_change() from public, anon, authenticated;
grant execute on function public.parking_booking_expire_permission_requests() to service_role;
