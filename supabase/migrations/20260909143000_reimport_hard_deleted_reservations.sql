-- Source-control the current reimport behavior and cover hard-deleted rows.
-- Existing active reservations from the same file still block duplicate import.
-- Soft-deleted reservations are restored.
-- If the historical batch remains but the selected reservations were physically removed,
-- recreate them from the current analysis instead of returning a false duplicate.

create or replace function public.parking_booking_import_commit(
  p_actor_telegram_user_id bigint,
  p_writer_epoch bigint,
  p_idempotency_key uuid,
  p_analysis_id uuid,
  p_selected_source_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.parking_booking_command_dedup%rowtype;
  v_analysis public.parking_booking_import_analyses%rowtype;
  v_existing_batch public.parking_booking_import_batches%rowtype;
  v_batch public.parking_booking_import_batches%rowtype;
  v_entry jsonb;
  v_norm jsonb;
  v_selected integer[] := '{}'::integer[];
  v_selected_value jsonb;
  v_source_row integer;
  v_imported integer := 0;
  v_restored integer := 0;
  v_recreated integer := 0;
  v_already_active integer := 0;
  v_ids jsonb := '[]'::jsonb;
  v_row public.parking_bookings%rowtype;
  v_response jsonb;
begin
  select * into v_existing
  from public.parking_booking_command_dedup
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.actor_telegram_user_id <> p_actor_telegram_user_id
       or v_existing.action <> 'import_commit' then
      raise exception using errcode = '22023', message = 'idempotency_key_reused';
    end if;
    return v_existing.response;
  end if;

  perform public.parking_booking_require_writer(
    p_actor_telegram_user_id,
    p_writer_epoch
  );

  select * into v_analysis
  from public.parking_booking_import_analyses
  where id = p_analysis_id
    and created_by_telegram_user_id = p_actor_telegram_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'import_analysis_not_found';
  end if;
  if v_analysis.expires_at <= now() then
    raise exception using errcode = '22023', message = 'import_analysis_expired';
  end if;

  if p_selected_source_rows is not null then
    if jsonb_typeof(p_selected_source_rows) <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_import_selection';
    end if;
    for v_selected_value in
      select value from jsonb_array_elements(p_selected_source_rows)
    loop
      v_source_row := (v_selected_value #>> '{}')::integer;
      if v_source_row = any(v_selected) then
        raise exception using errcode = '22023', message = 'invalid_import_selection';
      end if;
      v_selected := array_append(v_selected, v_source_row);
    end loop;
  end if;

  select * into v_existing_batch
  from public.parking_booking_import_batches
  where file_sha256 = v_analysis.file_sha256;

  if found then
    update public.parking_bookings
       set deleted_at = null,
           deleted_by_telegram_user_id = null,
           updated_by_telegram_user_id = p_actor_telegram_user_id,
           updated_at = now(),
           version = version + 1
     where import_batch_id = v_existing_batch.id
       and deleted_at is not null
       and (
         cardinality(v_selected) = 0
         or source_row = any(v_selected)
       );
    get diagnostics v_restored = row_count;

    select count(*)::integer
      into v_already_active
      from public.parking_bookings
     where import_batch_id = v_existing_batch.id
       and deleted_at is null
       and (
         cardinality(v_selected) = 0
         or source_row = any(v_selected)
       );

    update public.parking_booking_import_analyses
       set committed_at = coalesce(committed_at, now())
     where id = v_analysis.id;

    if v_restored > 0 then
      insert into public.parking_booking_admin_events(
        actor_telegram_user_id,
        action,
        entity_type,
        entity_id,
        metadata
      ) values (
        p_actor_telegram_user_id,
        'import_restore',
        'import_batch',
        v_existing_batch.id::text,
        jsonb_build_object(
          'analysis_id', v_analysis.id,
          'file_name', v_analysis.file_name,
          'restored_count', v_restored,
          'selected_source_rows', to_jsonb(v_selected)
        )
      );

      v_response := jsonb_build_object(
        'duplicate', false,
        'restored', true,
        'recreated', false,
        'batch_id', v_existing_batch.id,
        'count', v_restored,
        'already_active_count', greatest(v_already_active - v_restored, 0)
      );
    elsif v_already_active > 0 then
      v_response := jsonb_build_object(
        'duplicate', true,
        'restored', false,
        'recreated', false,
        'batch_id', v_existing_batch.id,
        'count', v_already_active
      );
    else
      -- The import batch exists, but the selected reservations were physically
      -- removed (for example by a technical cleanup). Recreate only the rows
      -- selected in the current import analysis.
      for v_entry in
        select value from jsonb_array_elements(v_analysis.valid_rows)
      loop
        v_source_row := nullif(v_entry ->> 'source_row', '')::integer;
        if cardinality(v_selected) > 0
           and not (v_source_row = any(v_selected)) then
          continue;
        end if;

        v_norm := public.parking_booking_normalize_entry(v_entry);

        insert into public.parking_bookings(
          pickup_date,
          pickup_time,
          pickup_terminal,
          return_date,
          return_time,
          return_terminal,
          price_eur,
          customer_name,
          customer_email,
          customer_phone,
          vehicle_plate,
          vehicle_make_model,
          payment_method,
          source_type,
          import_batch_id,
          source_row,
          created_by_telegram_user_id,
          updated_by_telegram_user_id
        ) values (
          (v_norm ->> 'pickup_date')::date,
          (v_norm ->> 'pickup_time')::time,
          v_norm ->> 'pickup_terminal',
          (v_norm ->> 'return_date')::date,
          (v_norm ->> 'return_time')::time,
          v_norm ->> 'return_terminal',
          (v_norm ->> 'price_eur')::numeric,
          v_norm ->> 'customer_name',
          nullif(v_norm ->> 'customer_email', ''),
          nullif(v_norm ->> 'customer_phone', ''),
          v_norm ->> 'vehicle_plate',
          nullif(v_norm ->> 'vehicle_make_model', ''),
          v_norm ->> 'payment_method',
          'ai_import',
          v_existing_batch.id,
          v_source_row,
          p_actor_telegram_user_id,
          p_actor_telegram_user_id
        ) returning * into v_row;

        v_recreated := v_recreated + 1;
        v_ids := v_ids || jsonb_build_array(v_row.id);
      end loop;

      if v_recreated < 1 then
        raise exception using errcode = '22023', message = 'empty_import_selection';
      end if;

      insert into public.parking_booking_admin_events(
        actor_telegram_user_id,
        action,
        entity_type,
        entity_id,
        metadata
      ) values (
        p_actor_telegram_user_id,
        'import_recreate',
        'import_batch',
        v_existing_batch.id::text,
        jsonb_build_object(
          'analysis_id', v_analysis.id,
          'file_name', v_analysis.file_name,
          'recreated_count', v_recreated,
          'booking_ids', v_ids,
          'selected_source_rows', to_jsonb(v_selected)
        )
      );

      v_response := jsonb_build_object(
        'duplicate', false,
        'restored', false,
        'recreated', true,
        'batch_id', v_existing_batch.id,
        'count', v_recreated,
        'booking_ids', v_ids
      );
    end if;

    insert into public.parking_booking_command_dedup(
      idempotency_key,
      actor_telegram_user_id,
      action,
      response
    ) values (
      p_idempotency_key,
      p_actor_telegram_user_id,
      'import_commit',
      v_response
    );

    return v_response;
  end if;

  insert into public.parking_booking_import_batches(
    analysis_id,
    file_name,
    file_sha256,
    ai_provider,
    ai_model,
    total_rows,
    imported_rows,
    created_by_telegram_user_id
  ) values (
    v_analysis.id,
    v_analysis.file_name,
    v_analysis.file_sha256,
    v_analysis.ai_provider,
    v_analysis.ai_model,
    jsonb_array_length(v_analysis.valid_rows),
    0,
    p_actor_telegram_user_id
  ) returning * into v_batch;

  for v_entry in
    select value from jsonb_array_elements(v_analysis.valid_rows)
  loop
    v_source_row := nullif(v_entry ->> 'source_row', '')::integer;
    if cardinality(v_selected) > 0
       and not (v_source_row = any(v_selected)) then
      continue;
    end if;

    v_norm := public.parking_booking_normalize_entry(v_entry);

    insert into public.parking_bookings(
      pickup_date,
      pickup_time,
      pickup_terminal,
      return_date,
      return_time,
      return_terminal,
      price_eur,
      customer_name,
      customer_email,
      customer_phone,
      vehicle_plate,
      vehicle_make_model,
      payment_method,
      source_type,
      import_batch_id,
      source_row,
      created_by_telegram_user_id,
      updated_by_telegram_user_id
    ) values (
      (v_norm ->> 'pickup_date')::date,
      (v_norm ->> 'pickup_time')::time,
      v_norm ->> 'pickup_terminal',
      (v_norm ->> 'return_date')::date,
      (v_norm ->> 'return_time')::time,
      v_norm ->> 'return_terminal',
      (v_norm ->> 'price_eur')::numeric,
      v_norm ->> 'customer_name',
      nullif(v_norm ->> 'customer_email', ''),
      nullif(v_norm ->> 'customer_phone', ''),
      v_norm ->> 'vehicle_plate',
      nullif(v_norm ->> 'vehicle_make_model', ''),
      v_norm ->> 'payment_method',
      'ai_import',
      v_batch.id,
      v_source_row,
      p_actor_telegram_user_id,
      p_actor_telegram_user_id
    ) returning * into v_row;

    v_imported := v_imported + 1;
    v_ids := v_ids || jsonb_build_array(v_row.id);
  end loop;

  if v_imported < 1 then
    raise exception using errcode = '22023', message = 'empty_import_selection';
  end if;

  update public.parking_booking_import_batches
     set imported_rows = v_imported
   where id = v_batch.id;

  update public.parking_booking_import_analyses
     set committed_at = now()
   where id = v_analysis.id;

  insert into public.parking_booking_admin_events(
    actor_telegram_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    p_actor_telegram_user_id,
    'import_commit',
    'import_batch',
    v_batch.id::text,
    jsonb_build_object(
      'analysis_id', v_analysis.id,
      'file_name', v_analysis.file_name,
      'count', v_imported,
      'booking_ids', v_ids,
      'ai_model', v_analysis.ai_model
    )
  );

  v_response := jsonb_build_object(
    'duplicate', false,
    'restored', false,
    'recreated', false,
    'batch_id', v_batch.id,
    'count', v_imported,
    'booking_ids', v_ids
  );

  insert into public.parking_booking_command_dedup(
    idempotency_key,
    actor_telegram_user_id,
    action,
    response
  ) values (
    p_idempotency_key,
    p_actor_telegram_user_id,
    'import_commit',
    v_response
  );

  return v_response;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_import_selection';
end;
$function$;
